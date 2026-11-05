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
 * beside it, refreshed whenever the release or the file changes.
 *
 * The bucket's Terraform state then holds only a pointer: no resources, and
 * one output naming the backend and the lineage of the state it holds. A
 * machine without the file refuses to run instead of planning an empty
 * installation, and a file that points at a backend holding another state
 * is refused. `init` moves the bucket's state (or a local state of a release
 * before 0.1.0) into an empty backend: it pushes it, reads it back and
 * compares it, keeps a copy in the instance directory, and only then writes
 * the pointer. Moving between two backends of the operator's own is
 * Terraform's job: `init -migrate-state`, which keeps the lineage.
 */
import { createHash, randomUUID } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
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

/**
 * The installation's own backend, when its Terraform directory has a
 * `backend_override.tf`: copies this release's root and modules beside it
 * (again only when either changed) and returns where Terraform runs.
 */
export function ownBackend(files: InstanceTerraform): OwnBackend | undefined {
  const file = ownBackendFile(files)
  if (!existsSync(file)) return undefined
  const repository = resolve(files.root, "..", "..")
  const sources = [`roots/${files.name}`, "modules"]
  const hash = createHash("sha256")
  for (const source of sources)
    for (const path of treeFiles(join(repository, source)))
      hash
        .update(`${source}/${path}\0`)
        .update(readFileSync(join(repository, source, path)))
        .update("\0")
  const stamp = hash.update(readFileSync(file)).digest("hex")
  const copy = join(files.directory, "own-backend")
  const root = join(copy, "roots", files.name)
  const stampFile = join(copy, ".stamp")
  if (!existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    rmSync(copy, { recursive: true, force: true })
    for (const source of sources)
      cpSync(join(repository, source), join(copy, source), {
        recursive: true,
        filter: (path) => !path.split(/[\\/]/u).includes(".terraform"),
      })
    cpSync(file, join(root, "backend_override.tf"))
    writePrivate(stampFile, stamp)
  }
  return { root, data: join(files.directory, ".terraform-own") }
}

/**
 * Refuses a command in the installation's own backend until `init` has
 * initialized it.
 */
export function assertOwnInitialized(
  own: OwnBackend,
  files: InstanceTerraform,
  init: string
): void {
  if (!existsSync(join(own.data, "terraform.tfstate")))
    throw new InstanceError(
      `${ownBackendFile(files)} names this installation's own backend, which is not initialized yet. Run:\n  ${init}`
    )
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
  /** The lineage of the state in that backend; null until it holds one. */
  lineage: z.string().nullable(),
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

/** What {@link reconcileOwnBackend} did, or would do. */
export type Reconciled =
  | { action: "none" }
  | { action: "record"; kept: string[] }
  | { action: "move"; kept: string[] }

/**
 * Makes the bucket point at the installation's own backend, moving its
 * state there first when that backend has none; with `write` false it only
 * says whether anything would change. Writes need the installation's
 * operation record held, and `init` to have initialized both the bucket's
 * configuration (`bucket`) and the own backend (`own`).
 *
 * @throws InstanceError When the own backend holds another state than this
 *   installation's, or the bucket and a local state disagree; nothing is
 *   written then.
 */
export function reconcileOwnBackend(
  files: InstanceTerraform,
  runs: { bucket: TerraformRun; own: TerraformRun },
  options: { write: boolean; now?: Date }
): Reconciled {
  const file = ownBackendFile(files)
  const backend = declaredBackend(files)
  const bucket = readBackendState(runs.bucket, "the state bucket")
  let own = readBackendState(runs.own, `the backend in ${file}`)
  const ownLineage = () =>
    own.kind === "state" || own.kind === "pointer"
      ? own.state.lineage
      : own.state?.lineage
  const local = localState(files)
  const now = options.now ?? new Date()
  const time = now.toISOString().replaceAll(/[:.]/gu, "-")

  if (own.kind === "pointer")
    throw new InstanceError(
      `The backend in ${file} holds the state bucket's pointer, not this installation's state. Point it at another backend.`
    )

  const pointTo = (lineage: string | null) => {
    const pointer: StatePointer = {
      backend,
      lineage,
      at: now.toISOString(),
      by: hostname(),
    }
    const previous = bucket.state
    const version = previous?.terraform_version ?? terraformVersion(runs.own)
    const next = {
      version: 4,
      terraform_version: version,
      serial: (z.number().safeParse(previous?.serial).data ?? 0) + 1,
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
    if (written.kind !== "pointer" || written.pointer.lineage !== lineage)
      throw new InstanceError(
        "The state bucket did not keep the pointer to this installation's own backend. Inspect it before you retry."
      )
  }

  if (bucket.kind === "pointer") {
    if (local)
      throw new InstanceError(
        `${files.state} holds a local state from a release before 0.1.0, but this installation's state already lives in its own backend. Check which one is current, then move the other out of the way.`
      )
    const recorded = bucket.pointer.lineage
    if (recorded === null) {
      // Recorded before the backend held a state: the first one it holds is
      // this installation's.
      if (own.kind !== "state") return { action: "none" }
      if (options.write) pointTo(own.state.lineage)
      return { action: "record", kept: [] }
    }
    if (ownLineage() === recorded) return { action: "none" }
    throw new InstanceError(
      `The backend in ${file} does not hold this installation's state: the state bucket records lineage ${recorded} in its own ${bucket.pointer.backend} backend. If you moved the state to a new backend, move it with Terraform (init -migrate-state keeps its lineage).`
    )
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
    // A new installation, or one never applied: its state starts in its own backend.
    if (options.write) pointTo(own.kind === "state" ? own.state.lineage : null)
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
  if (action === "move") {
    // -force: an empty backend may hold an empty state of its own lineage
    // (GCS). The operation record keeps every other writer away meanwhile.
    push(runs.own, files, source, `the backend in ${file}`, true)
    own = readBackendState(runs.own, `the backend in ${file}`)
  }
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
  pointTo(own.state.lineage)
  return { action, kept }
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
 * the bucket at it, moving the state first when the backend has none. Takes
 * the installation's operation record only when something changes.
 */
export function initOwnBackend(options: {
  files: InstanceTerraform
  runs: { bucket: TerraformRun; own: TerraformRun }
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
