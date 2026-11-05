/**
 * An installation can keep Terraform's state in a backend of its own instead
 * of its bucket: a `backend_override.tf` that the operator writes in the
 * instance's Terraform directory, with any Terraform `backend` block or a
 * `cloud` block (HCP Terraform, Terraform Enterprise). Nothing else moves:
 * the app's install state and keys stay in the bucket and the secret store.
 *
 *   <instance>/terraform/<root>/
 *     backend_override.tf      the operator's backend; replaces the root's own
 *     own-backend/             this release's root and modules, with the file
 *     .terraform-own/          Terraform's working data for that backend
 *     bucket-state/            a backend-only configuration for the bucket
 *
 * Terraform's override files replace a root's backend block, so the drivers
 * run Terraform in the instance's copy of this release's root with the file
 * beside it. A refresh replaces only the files it copied, so a local
 * backend's state in the copy stays.
 *
 * The bucket's Terraform state then holds only a pointer: no resources, and
 * one output recording the installation's current state (its lineage, its
 * serial and a digest of its resources and outputs), written inside the
 * operation record after every command that changes the state. Every
 * command checks it, again inside the operation record when it changes
 * anything: without the file the drivers refuse to plan the bucket as an
 * empty installation, and with it they accept only a backend that holds the
 * current state: the same lineage at the recorded serial or later, or
 * exactly the recorded resources and outputs (a copy Terraform's
 * `init -migrate-state` made, which may carry a new lineage). An older copy
 * left behind by a migration, another installation's state and an empty
 * backend are refused.
 *
 * `init` moves the bucket's state (or a local state of a release before
 * 0.1.0) into an empty backend: it pushes it, checks the bucket did not
 * change (the backend is not the bucket itself), reads it back and compares
 * it, keeps a copy in the instance directory, and only then writes the
 * pointer. A new installation's empty backend gets an empty state of its
 * own lineage first. A backend that already holds another state is never
 * adopted.
 */
import { createHash, randomUUID } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import {
  InstanceError,
  ROOT_BACKENDS,
  writePrivate,
  type InstanceTerraform,
} from "./instance"
import {
  contents,
  localState,
  localStateSchema,
  withOperation,
  type installStore,
  type TerraformRun,
} from "./state"

/** The operator's backend file for root `files.name`. */
export function ownBackendFile(files: InstanceTerraform): string {
  return join(files.directory, "backend_override.tf")
}

/** Where Terraform runs for an installation with its own backend. */
export type OwnBackend = {
  /** The root to run Terraform in: the copy with the operator's file. */
  root: string
  /** Its working data (`TF_DATA_DIR`). */
  data: string
}

/** Files of the release tree that make up a root's configuration, in a stable order. */
function treeFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== ".terraform")
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? treeFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`]
    )
}

const copySchema = z.object({ stamp: z.string(), files: z.array(z.string()) })

/**
 * The installation's own backend, when its Terraform directory has a
 * `backend_override.tf`: copies this release's root and modules beside it
 * and returns where Terraform runs. When the release or the file changed,
 * it replaces the files it copied before and nothing else.
 */
export function ownBackend(files: InstanceTerraform): OwnBackend | undefined {
  const file = ownBackendFile(files)
  if (!existsSync(file)) return undefined
  const repository = resolve(files.root, "..", "..")
  const managed = [`roots/${files.name}`, "modules"].flatMap((source) =>
    treeFiles(join(repository, source)).map((path) => `${source}/${path}`)
  )
  const hash = createHash("sha256")
  for (const path of managed)
    hash
      .update(`${path}\0`)
      .update(readFileSync(join(repository, path)))
      .update("\0")
  const stamp = hash.update(readFileSync(file)).digest("hex")
  const copy = join(files.directory, "own-backend")
  const root = join(copy, "roots", files.name)
  const record = join(copy, ".copied.json")
  const previous = existsSync(record)
    ? copySchema.safeParse(JSON.parse(readFileSync(record, "utf8"))).data
    : undefined
  if (previous?.stamp !== stamp) {
    for (const path of previous?.files ?? [])
      rmSync(join(copy, path), { force: true })
    for (const path of managed) {
      mkdirSync(dirname(join(copy, path)), { recursive: true })
      copyFileSync(join(repository, path), join(copy, path))
    }
    const override = `roots/${files.name}/backend_override.tf`
    copyFileSync(file, join(copy, override))
    writePrivate(
      record,
      `${JSON.stringify({ stamp, files: [...managed, override] })}\n`
    )
  }
  return { root, data: join(files.directory, ".terraform-own") }
}

/**
 * A configuration with only the bucket's backend block, so the bucket's
 * state can be read and written without the root's providers. Returns its
 * directory and working data.
 */
export function bucketConfiguration(files: InstanceTerraform): OwnBackend {
  const root = join(files.directory, "bucket-state")
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writePrivate(
    join(root, "main.tf"),
    `terraform {\n  backend "${ROOT_BACKENDS[files.name]}" {}\n}\n`
  )
  return { root, data: join(root, ".terraform") }
}

/** The output the bucket's state holds once the installation's state lives in its own backend. */
export const POINTER_OUTPUT = "azad_state_moved"

const pointerSchema = z.object({
  /** The backend type, or `cloud`, as the operator's file named it. */
  backend: z.string(),
  /** The current state's lineage, serial and {@link digestOf} digest. */
  lineage: z.string(),
  serial: z.number(),
  digest: z.string(),
  at: z.string(),
  by: z.string(),
})
export type StatePointer = z.infer<typeof pointerSchema>

type State = z.infer<typeof localStateSchema>

/** What a backend's `state pull` holds. */
export type BackendState =
  | { kind: "none"; state?: State }
  | { kind: "pointer"; state: State; pointer: StatePointer }
  | { kind: "state"; state: State }

/**
 * Reads a backend's state. A backend without one answers with nothing, or
 * (GCS) with an empty state of its own lineage: both are `none`.
 */
export function readBackendState(
  terraform: TerraformRun,
  what: string
): BackendState {
  const pulled = terraform(["state", "pull"], { capture: true })
  if (pulled.status !== 0)
    throw new InstanceError(`Terraform could not read ${what}.`)
  if (!pulled.stdout.trim()) return { kind: "none" }
  const state = localStateSchema.parse(JSON.parse(pulled.stdout))
  const output = z
    .object({ value: z.string() })
    .safeParse(state.outputs[POINTER_OUTPUT])
  if (output.success)
    return {
      kind: "pointer",
      state,
      pointer: pointerSchema.parse(JSON.parse(output.data.value)),
    }
  return state.resources.length || Object.keys(state.outputs).length
    ? { kind: "state", state }
    : { kind: "none", state }
}

const serialOf = (state?: State) =>
  z.number().safeParse(state?.serial).data ?? 0

/** A JSON value with its object keys sorted, so equal data prints alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
  return value
}

const instanceSchema = z.looseObject({
  index_key: z.unknown().optional(),
  attributes: z.unknown().optional(),
})
const resourceSchema = z.looseObject({
  module: z.string().optional(),
  mode: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  instances: z.array(instanceSchema).default([]),
})

/**
 * The digest of what a state records: each resource instance's address and
 * attributes, and each output's value. Bookkeeping that Terraform versions
 * add or format differently (lineage, serial, sensitivity paths, identity
 * schema versions) is left out, so the same state digests alike after an
 * upgrade or a migration.
 */
export function digestOf(state?: State): string {
  const resources = (state?.resources ?? [])
    .map((resource) => resourceSchema.parse(resource))
    .map((resource) => ({
      address: [resource.module, resource.mode, resource.type, resource.name]
        .map((part) => part ?? "")
        .join("|"),
      instances: resource.instances
        .map((instance) => ({
          key: JSON.stringify(instance.index_key ?? null),
          attributes: canonical(instance.attributes ?? null),
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.address.localeCompare(b.address))
  const outputs = Object.fromEntries(
    Object.entries(state?.outputs ?? {}).map(([name, output]) => [
      name,
      canonical(
        z.looseObject({ value: z.unknown() }).safeParse(output).data?.value ??
          null
      ),
    ])
  )
  return createHash("sha256")
    .update(JSON.stringify(canonical({ resources, outputs })))
    .digest("hex")
}
/** The digest of a state without resources or outputs. */
const EMPTY = digestOf()

/**
 * Whether a backend holds the installation's current state, as the pointer
 * records it: the same lineage at a later serial, or at the same serial
 * with the same contents; or, with another lineage (a migrated copy may get
 * a new one), exactly the recorded contents. An empty recorded state
 * matches by lineage only, so any other empty backend does not.
 */
function holdsCurrent(pointer: StatePointer, own: BackendState): boolean {
  if (!own.state) return false
  const serial = serialOf(own.state)
  const same = digestOf(own.state) === pointer.digest
  if (own.state.lineage === pointer.lineage)
    return serial > pointer.serial || (serial === pointer.serial && same)
  return pointer.digest !== EMPTY && same
}

/** The backend type a `backend_override.tf` declares: `cloud`, or its `backend` block's label. */
export function declaredBackend(files: InstanceTerraform): string {
  const text = readFileSync(ownBackendFile(files), "utf8")
  if (/^\s*cloud\s*\{/mu.test(text)) return "cloud"
  const label = /^\s*backend\s+"([a-z0-9_-]+)"/mu.exec(text)
  if (!label)
    throw new InstanceError(
      `${ownBackendFile(files)} declares no backend: write a terraform block with a backend "<type>" {} or a cloud {} block.`
    )
  return label[1]
}

/**
 * Refuses a command against the bucket's state once it holds the pointer:
 * the installation's state lives in its own backend, and the bucket would
 * plan it as empty.
 */
export function assertStateHere(
  terraform: TerraformRun,
  files: InstanceTerraform,
  init: string
): void {
  const bucket = readBackendState(terraform, "the state bucket")
  if (bucket.kind === "pointer")
    throw new InstanceError(
      `This installation keeps Terraform's state in its own ${bucket.pointer.backend} backend (since ${bucket.pointer.at}, from ${bucket.pointer.by}), so the state bucket holds only a pointer to it. Put its backend_override.tf back in ${files.directory}, then run:\n  ${init}`
    )
}

/** Runners for the bucket's configuration and the own backend. */
export type Runs = { bucket: TerraformRun; own: TerraformRun }

const notCurrent = (file: string, pointer: StatePointer) =>
  `The backend in ${file} does not hold this installation's current Terraform state (lineage ${pointer.lineage}, serial ${pointer.serial}, written ${pointer.at} from ${pointer.by}): it is empty, older or another installation's. Point the file at the backend that holds the current state, or move that state there with init -migrate-state.`

/**
 * Refuses a command in the installation's own backend unless `init`
 * completed here and the backend holds the installation's current state.
 * Run it inside the operation record before a command that changes
 * anything.
 */
export function assertOwnCurrent(
  files: InstanceTerraform,
  own: OwnBackend,
  runs: Runs,
  init: string
): void {
  const file = ownBackendFile(files)
  const bucketData = join(bucketConfiguration(files).data, "terraform.tfstate")
  if (
    !existsSync(join(own.data, "terraform.tfstate")) ||
    !existsSync(bucketData)
  )
    throw new InstanceError(
      `${file} names this installation's own backend, which is not initialized yet. Run:\n  ${init}`
    )
  const bucket = readBackendState(runs.bucket, "the state bucket")
  if (bucket.kind !== "pointer")
    throw new InstanceError(
      `The state bucket does not point at the backend in ${file} yet. Run:\n  ${init}`
    )
  if (
    !holdsCurrent(
      bucket.pointer,
      readBackendState(runs.own, `the backend in ${file}`)
    )
  )
    throw new InstanceError(notCurrent(file, bucket.pointer))
}

/** What {@link reconcileOwnBackend} did, or would do. */
export type Reconciled =
  | { action: "none" }
  | { action: "record"; kept: string[] }
  | { action: "move"; kept: string[] }

/**
 * Makes the bucket point at the installation's current state in its own
 * backend, moving the state there first when that backend has none; with
 * `write` false it only says whether anything would change. Writes need the
 * installation's operation record held, and `init` to have initialized
 * both configurations.
 *
 * @throws InstanceError When the own backend is the bucket itself, does not
 *   hold the current state, holds another state than this installation's,
 *   or the bucket and a local state disagree; nothing is moved then.
 */
export function reconcileOwnBackend(
  files: InstanceTerraform,
  runs: Runs,
  options: { write: boolean; now?: Date }
): Reconciled {
  const file = ownBackendFile(files)
  const backend = declaredBackend(files)
  const bucket = readBackendState(runs.bucket, "the state bucket")
  let own = readBackendState(runs.own, `the backend in ${file}`)
  const local = localState(files)
  const now = options.now ?? new Date()
  const time = now.toISOString().replaceAll(/[:.]/gu, "-")
  const aliased = `The backend in ${file} is the state bucket's own state. Point it at another bucket, key or workspace.`
  if (own.kind === "pointer") throw new InstanceError(aliased)
  const readOwn = () => readBackendState(runs.own, `the backend in ${file}`)

  /** Records the own backend's state, as it is now, in the bucket's pointer. */
  const pointAt = (state: State) => {
    const pointer: StatePointer = {
      backend,
      lineage: state.lineage,
      serial: serialOf(state),
      digest: digestOf(state),
      at: now.toISOString(),
      by: hostname(),
    }
    const previous = bucket.state
    const next = {
      version: 4,
      terraform_version:
        previous?.terraform_version ?? terraformVersion(runs.own),
      serial: serialOf(previous) + 1,
      lineage: previous?.lineage || randomUUID(),
      outputs: {
        [POINTER_OUTPUT]: { value: JSON.stringify(pointer), type: "string" },
      },
      resources: [],
      check_results: null,
    }
    // -force over a bucket without a state: it may answer with an empty
    // one of another lineage. A state or an earlier pointer keeps its own.
    push(runs.bucket, files, next, "the state bucket", bucket.kind === "none")
    const written = readBackendState(runs.bucket, "the state bucket")
    if (
      written.kind !== "pointer" ||
      written.pointer.digest !== pointer.digest ||
      written.pointer.serial !== pointer.serial
    )
      throw new InstanceError(
        "The state bucket did not keep the pointer to this installation's own backend. Inspect it before you retry."
      )
    if (readOwn().kind === "pointer") throw new InstanceError(aliased)
  }
  /** After a write to the own backend: the bucket must not have changed with it. */
  const assertDistinct = () => {
    const after = readBackendState(runs.bucket, "the state bucket")
    if (JSON.stringify(after.state) !== JSON.stringify(bucket.state))
      throw new InstanceError(aliased)
  }

  if (bucket.kind === "pointer") {
    if (local)
      throw new InstanceError(
        `${files.state} holds a local state from a release before 0.1.0, but this installation's state already lives in its own backend. Check which one is current, then move the other out of the way.`
      )
    const { pointer } = bucket
    if (!own.state || !holdsCurrent(pointer, own))
      throw new InstanceError(notCurrent(file, pointer))
    const unchanged =
      own.state.lineage === pointer.lineage &&
      serialOf(own.state) === pointer.serial &&
      digestOf(own.state) === pointer.digest
    if (unchanged) return { action: "none" }
    if (options.write) pointAt(own.state)
    return { action: "record", kept: [] }
  }

  if (
    local &&
    bucket.kind === "state" &&
    contents(local) !== contents(bucket.state)
  )
    throw new InstanceError(
      `${files.state} and the state bucket hold different states. Nothing was moved; check which one is current.`
    )
  const source = local ?? (bucket.kind === "state" ? bucket.state : undefined)
  if (!source) {
    if (own.kind === "state")
      throw new InstanceError(
        `The backend in ${file} already holds a state, and this installation has none to compare it with. Nothing was recorded; point the file at an empty backend.`
      )
    if (!options.write) return { action: "record", kept: [] }
    // A new installation: its state starts there, with a lineage of its own
    // that the pointer records, so no other empty backend passes for it.
    push(
      runs.own,
      files,
      {
        version: 4,
        terraform_version: terraformVersion(runs.own),
        serial: serialOf(own.state) + 1,
        lineage: own.state?.lineage || randomUUID(),
        outputs: {},
        resources: [],
        check_results: null,
      },
      `the backend in ${file}`,
      true
    )
    assertDistinct()
    own = readOwn()
    if (!own.state || own.kind !== "none")
      throw new InstanceError(
        `The backend in ${file} did not keep the empty state written there. Inspect it before you retry.`
      )
    pointAt(own.state)
    return { action: "record", kept: [] }
  }
  // Already there (moved with Terraform, or by an init that stopped before
  // the pointer), or moved now.
  const action = own.kind === "state" ? "record" : "move"
  if (own.kind === "state" && contents(own.state) !== contents(source))
    throw new InstanceError(
      `The backend in ${file} already holds a different state from this installation's. Nothing was moved.`
    )
  if (!options.write) return { action, kept: [] }
  if (own.kind === "state") {
    // The same contents may be the bucket's own object under another name:
    // write it once more there, and the bucket must not change.
    push(
      runs.own,
      files,
      { ...own.state, serial: serialOf(own.state) + 1 },
      `the backend in ${file}`
    )
  } else {
    // -force: an empty backend may hold an empty state of its own lineage
    // (GCS). The operation record keeps every other writer away meanwhile.
    push(runs.own, files, source, `the backend in ${file}`, true)
  }
  assertDistinct()
  own = readOwn()
  if (own.kind !== "state" || contents(own.state) !== contents(source))
    throw new InstanceError(
      `The state read back from the backend in ${file} differs from this installation's, which is unchanged in the state bucket. Inspect that backend before you retry.`
    )
  const kept: string[] = []
  if (bucket.kind === "state") {
    const copy = `${files.state}.before-own-backend-${time}`
    writePrivate(copy, `${JSON.stringify(bucket.state, null, 2)}\n`)
    kept.push(copy)
  }
  if (local) {
    const copy = `${files.state}.before-remote-${time}`
    renameSync(files.state, copy)
    if (existsSync(`${files.state}.backup`))
      renameSync(`${files.state}.backup`, `${copy}.previous`)
    kept.push(copy)
  }
  pointAt(own.state)
  return { action, kept }
}

/**
 * After a command that may have changed the own backend's state, whether or
 * not it succeeded (a failed apply keeps what it created): records the
 * state as it is now in the bucket's pointer. Run it inside the operation
 * record that command held. A failure only leaves the pointer as it was.
 */
export function recordOwnState(files: InstanceTerraform, runs: Runs): void {
  try {
    reconcileOwnBackend(files, runs, { write: true })
  } catch (error) {
    process.stderr.write(
      `The state bucket's pointer was not updated: ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

/** Writes `state` with `terraform state push` through a private file that is removed afterwards. */
function push(
  terraform: TerraformRun,
  files: InstanceTerraform,
  state: object,
  what: string,
  force = false
) {
  const path = join(files.directory, `.state-${randomUUID()}.tfstate`)
  writePrivate(path, `${JSON.stringify(state, null, 2)}\n`)
  try {
    const args = ["state", "push", ...(force ? ["-force"] : []), path]
    if (terraform(args).status !== 0)
      throw new InstanceError(`Terraform could not write ${what}.`)
  } finally {
    unlinkSync(path)
  }
}

/** The running Terraform's version, for a state written where none existed. */
function terraformVersion(terraform: TerraformRun): string {
  const result = terraform(["version", "-json"], { capture: true })
  const version = z
    .object({ terraform_version: z.string() })
    .safeParse(JSON.parse(result.stdout || "{}"))
  if (result.status !== 0 || !version.success)
    throw new InstanceError("Terraform did not report its version.")
  return version.data.terraform_version
}

/**
 * `init` for an installation with its own backend: initializes the bucket's
 * configuration and the own backend (with the operator's init arguments,
 * so `-migrate-state` between two own backends is Terraform's), then points
 * the bucket at the current state there, moving the state first when the
 * backend has none. Takes the installation's operation record only when
 * something changes.
 */
export function initOwnBackend(options: {
  files: InstanceTerraform
  runs: Runs
  forwarded: string[]
  store: Pick<ReturnType<typeof installStore>, "acquire" | "finish" | "stop">
  takeOver?: string
}): number {
  const { files, runs } = options
  let status = runs.bucket(
    [
      "init",
      "-reconfigure",
      `-backend-config=${files.backend}`,
      "-input=false",
    ],
    { capture: true }
  ).status
  if (status !== 0) return status
  status = runs.own(["init", ...options.forwarded]).status
  if (status !== 0) return status
  if (reconcileOwnBackend(files, runs, { write: false }).action === "none")
    return 0
  let done = { action: "none" } as Reconciled
  status = withOperation(
    options.store,
    "terraform-state-move",
    { takeOver: options.takeOver },
    () => {
      done = reconcileOwnBackend(files, runs, { write: true })
      return 0
    }
  )
  const file = ownBackendFile(files)
  if (done.action === "move")
    process.stdout.write(
      `Moved this installation's Terraform state into the backend in ${file}. The state bucket now holds only a pointer to it; the earlier copies are kept as ${done.kept.join(" and ")}.\n`
    )
  else if (done.action === "record")
    process.stdout.write(
      `The state bucket now points at the backend in ${file}, where this installation's Terraform state lives.${done.kept.length ? ` The earlier copies are kept as ${done.kept.join(" and ")}.` : ""}\n`
    )
  return status
}
