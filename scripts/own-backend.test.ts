import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { instanceTerraform, type InstanceTerraform } from "./instance"
import {
  assertOwnCurrent,
  assertStateHere,
  declaredBackend,
  digestOf,
  ownBackend,
  ownBackendFile,
  POINTER_OUTPUT,
  reconcileOwnBackend,
  beginOwnWrite,
  finishOwnWrite,
  type OwnBackend,
  type Runs,
} from "./own-backend"
import type { TerraformRun } from "./state"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "azad-terraform-own-"))
  directories.push(directory)
  return directory
}
function instance(root: "postgres" | "gcp-celld" = "postgres") {
  const files = instanceTerraform(join(temporary(), "instance"), root)
  mkdirSync(files.directory, { recursive: true })
  return files
}

const S3 = 'terraform {\n  backend "s3" {\n    bucket = "team-state"\n  }\n}\n'

test("without a backend_override.tf Terraform keeps running in this release's root", () => {
  expect(ownBackend(instance())).toBeUndefined()
})

test("the override runs in a copy of this release's root and modules; a refresh keeps a local backend's state", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  const own = ownBackend(files)
  expect(own).toEqual({
    root: join(files.directory, "own-backend", "roots", "postgres"),
    data: join(files.directory, ".terraform-own"),
  })
  const root = own?.root ?? ""
  expect(readFileSync(join(root, "backend_override.tf"), "utf8")).toBe(S3)
  expect(existsSync(join(root, "main.tf"))).toBe(true)
  expect(existsSync(join(root, ".terraform.lock.hcl"))).toBe(true)
  // The root's ../../modules sources resolve inside the copy.
  expect(
    existsSync(join(root, "..", "..", "modules", "base-postgres", "main.tf"))
  ).toBe(true)
  const copied = statSync(join(root, "main.tf")).mtimeMs
  ownBackend(files)
  expect(statSync(join(root, "main.tf")).mtimeMs).toBe(copied)
  // A backend "local" {} keeps its state in the copy's root.
  writeFileSync(join(root, "terraform.tfstate"), "the live state")
  mkdirSync(join(root, "terraform.tfstate.d", "blue"), { recursive: true })
  const local = 'terraform {\n  backend "local" {}\n}\n'
  writeFileSync(ownBackendFile(files), local)
  ownBackend(files)
  expect(readFileSync(join(root, "backend_override.tf"), "utf8")).toBe(local)
  expect(readFileSync(join(root, "terraform.tfstate"), "utf8")).toBe(
    "the live state"
  )
  expect(existsSync(join(root, "terraform.tfstate.d", "blue"))).toBe(true)
  expect(declaredBackend(files)).toBe("local")
})

test("the backend type comes from the operator's file", () => {
  const files = instance()
  writeFileSync(
    ownBackendFile(files),
    'terraform {\n  cloud {\n    organization = "team"\n  }\n}\n'
  )
  expect(declaredBackend(files)).toBe("cloud")
  writeFileSync(ownBackendFile(files), "# nothing here\n")
  expect(() => declaredBackend(files)).toThrow("declares no backend")
})

test("the digest covers resources and outputs, not the bookkeeping Terraform versions add", () => {
  // As a pulled state parses: plain JSON.
  const state = (instance: object, extra: object = {}) =>
    JSON.parse(
      JSON.stringify({
        lineage: "a",
        serial: 1,
        ...extra,
        resources: [
          { mode: "managed", type: "t", name: "n", instances: [instance] },
        ],
        outputs: { o: { value: { b: 2, a: 1 }, type: "object" } },
      })
    )
  const base = digestOf(
    state({ schema_version: 0, attributes: { id: "x", tags: { b: 1, a: 2 } } })
  )
  expect(
    digestOf(
      state(
        {
          schema_version: 0,
          attributes: { tags: { a: 2, b: 1 }, id: "x" },
          sensitive_attributes: [[{ type: "get_attr", value: "id" }]],
          identity_schema_version: 0,
        },
        { lineage: "b", serial: 9, terraform_version: "1.17.1" }
      )
    )
  ).toBe(base)
  expect(digestOf(state({ attributes: { id: "y" } }))).not.toBe(base)
  // What changes a plan changes the digest: a taint, a deposed object,
  // the provider an instance belongs to, provider-private data.
  const attributes = { id: "x", tags: { b: 1, a: 2 } }
  for (const instance of [
    { schema_version: 0, attributes, status: "tainted" },
    { schema_version: 0, attributes, deposed: "00000001" },
    {
      schema_version: 0,
      attributes,
      private: "eyJzY2hlbWFfdmVyc2lvbiI6IjEifQ==",
    },
    { schema_version: 0, attributes, dependencies: ["terraform_data.other"] },
  ])
    expect(digestOf(state(instance))).not.toBe(base)
  const other = state({ schema_version: 0, attributes })
  other.resources[0].provider =
    'provider["registry.terraform.io/hashicorp/other"]'
  expect(digestOf(other)).not.toBe(base)
  expect(digestOf()).not.toBe(base)
})

/** The `terraform` this suite runs against, when one is installed. */
const terraformBinary = Bun.which("terraform")

/** A Terraform configuration with only a local backend at `path`, and its runner. */
function localBackend(directory: string, name: string, path: string) {
  const where: OwnBackend = {
    root: join(directory, name),
    data: join(directory, `${name}-data`),
  }
  mkdirSync(where.root, { recursive: true })
  const configure = (at: string) =>
    writeFileSync(
      join(where.root, "main.tf"),
      `terraform {\n  backend "local" {\n    path = ${JSON.stringify(at)}\n  }\n}\n`
    )
  configure(path)
  const run: TerraformRun = (args, options = {}) => {
    const result = Bun.spawnSync(
      [terraformBinary ?? "terraform", `-chdir=${where.root}`, ...args],
      {
        env: {
          ...process.env,
          TF_DATA_DIR: where.data,
          TF_IN_AUTOMATION: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    return {
      status: result.exitCode ?? 1,
      stdout: options.capture ? result.stdout.toString() : "",
    }
  }
  const init = (...args: string[]) =>
    run(["init", "-input=false", ...args]).status
  return { where, run, init, configure }
}

/** A Terraform state with one resource and one output, as an apply writes it. */
function liveState(lineage: string, serial = 3) {
  return {
    version: 4,
    terraform_version: "1.13.4",
    serial,
    lineage,
    outputs: {
      deploy: {
        value: { fleets: 1 },
        type: ["object", { fleets: "number" }],
      },
    },
    resources: [
      {
        mode: "managed",
        type: "terraform_data",
        name: "api",
        provider: 'provider["terraform.io/builtin/terraform"]',
        instances: [
          {
            schema_version: 0,
            attributes: {
              id: "api",
              input: null,
              output: null,
              triggers_replace: null,
            },
            sensitive_attributes: [],
            identity_schema_version: 0,
          },
        ],
      },
    ],
    check_results: null,
  }
}
const LINEAGE = "6a1c7e2e-6f53-4c55-8a1e-0f4b8f0c1a2b"

/** An installation whose bucket and own backends are real local backends. */
function real(bucketState?: object) {
  const files = instance()
  const directory = temporary()
  const bucketPath = join(directory, "bucket.tfstate")
  if (bucketState) writeFileSync(bucketPath, JSON.stringify(bucketState))
  const bucket = localBackend(directory, "bucket", bucketPath)
  expect(bucket.init()).toBe(0)
  const machines = new Map([["own", files]])
  /**
   * The own backend at `path` as machine `name` uses it: its own instance
   * directory (the first machine's is `files`), with what init leaves in
   * the drivers' bucket-state configuration.
   */
  const own = (path: string, name = "own") => {
    const at = machines.get(name) ?? instance()
    machines.set(name, at)
    const bucketData = join(at.directory, "bucket-state", ".terraform")
    mkdirSync(bucketData, { recursive: true })
    writeFileSync(join(bucketData, "terraform.tfstate"), "{}")
    writeFileSync(
      ownBackendFile(at),
      `terraform {\n  backend "local" {\n    path = ${JSON.stringify(path)}\n  }\n}\n`
    )
    const backend = localBackend(directory, name, path)
    expect(backend.init()).toBe(0)
    return {
      ...backend,
      files: at,
      runs: { bucket: bucket.run, own: backend.run } as Runs,
    }
  }
  const read = (path: string) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined
  return { files, directory, bucketPath, bucket, own, read }
}
const pointerIn = (state: { outputs: Record<string, { value: string }> }) =>
  JSON.parse(state.outputs[POINTER_OUTPUT].value)
type Machine = {
  files: InstanceTerraform
  where: OwnBackend
  run: TerraformRun
  runs: Runs
}
const reconcile = (own: Machine, takeOver?: string) =>
  reconcileOwnBackend(own.files, own.runs, { write: true, takeOver })
const current = (own: Machine, takeOver?: string) => () =>
  assertOwnCurrent(own.files, own.where, own.runs, "init", takeOver)
/** A command that writes `next(state)` to `own`, as the drivers run one. */
function write(
  t: ReturnType<typeof real>,
  own: Machine,
  next: (state: Record<string, unknown> & { serial: number }) => object,
  runs: Runs = own.runs
) {
  beginOwnWrite(own.files, runs, "operation-1")
  const pulled = JSON.parse(
    own.run(["state", "pull"], { capture: true }).stdout
  )
  const path = join(t.directory, `write-${pulled.serial}.tfstate`)
  writeFileSync(path, JSON.stringify(next(pulled)))
  expect(own.run(["state", "push", path]).status).toBe(0)
  finishOwnWrite(own.files, runs)
}
/** An apply on `own`: the next serial, with another output. */
const apply = (t: ReturnType<typeof real>, own: Machine, value: number) =>
  write(t, own, (state) => ({
    ...state,
    serial: state.serial + 1,
    outputs: {
      ...(state.outputs as object),
      version: { value, type: "number" },
    },
  }))

test.skipIf(!terraformBinary)(
  "init moves the bucket's state into an empty own backend, then leaves only a pointer to it",
  () => {
    const t = real(liveState(LINEAGE))
    const ownPath = join(t.directory, "own.tfstate")
    const own = t.own(ownPath)
    expect(
      reconcileOwnBackend(t.files, own.runs, { write: false }).action
    ).toBe("move")
    expect(existsSync(ownPath)).toBe(false)
    const done = reconcile(own)
    expect(done.action).toBe("move")
    expect(t.read(ownPath).resources).toEqual(liveState(LINEAGE).resources)
    const kept = done.action === "none" ? "" : (done.kept[0] ?? "")
    expect(JSON.parse(readFileSync(kept, "utf8")).resources).toHaveLength(1)
    expect(statSync(kept).mode & 0o777).toBe(0o600)
    const bucket = t.read(t.bucketPath)
    expect(bucket.resources).toEqual([])
    expect(bucket.lineage).toBe(LINEAGE)
    expect(pointerIn(bucket)).toMatchObject({
      backend: "local",
      lineage: LINEAGE,
      serial: t.read(ownPath).serial,
      digest: digestOf(liveState(LINEAGE)),
    })
    expect(reconcile(own)).toEqual({ action: "none" })
    expect(current(own)).not.toThrow()
    expect(() => assertStateHere(t.bucket.run, t.files, "init")).toThrow(
      "keeps Terraform's state in its own local backend"
    )
  }
)

test.skipIf(!terraformBinary)(
  "an own backend that is the bucket's own state is refused, and its state stays",
  () => {
    const t = real(liveState(LINEAGE))
    const own = t.own(t.bucketPath)
    expect(() => reconcile(own)).toThrow("is the state bucket's own state")
    expect(t.read(t.bucketPath).resources).toEqual(liveState(LINEAGE).resources)
    // The same with a local state to move, and with nothing yet.
    const local = real()
    writeFileSync(local.files.state, JSON.stringify(liveState(LINEAGE)))
    expect(() => reconcile(local.own(local.bucketPath))).toThrow(
      "is the state bucket's own state"
    )
    expect(existsSync(local.files.state)).toBe(true)
    const fresh = real()
    expect(() => reconcile(fresh.own(fresh.bucketPath))).toThrow(
      "is the state bucket's own state"
    )
  }
)

test.skipIf(!terraformBinary)(
  "after init -migrate-state, the old backend is refused once the new one changes",
  () => {
    const t = real(liveState(LINEAGE))
    const x = join(t.directory, "x.tfstate")
    const a = t.own(x, "a")
    reconcile(a)
    const b = t.own(x, "b")
    // Machine A moves the state on to Y with Terraform.
    a.configure(join(t.directory, "y.tfstate"))
    expect(a.init("-migrate-state", "-force-copy")).toBe(0)
    expect(reconcile(a).action).not.toBe("move")
    // X still holds the same copy: harmless until Y changes.
    expect(current(b)).not.toThrow()
    apply(t, a, 2)
    expect(current(a)).not.toThrow()
    expect(t.read(x).lineage).toBe(LINEAGE)
    expect(current(b)).toThrow("does not hold this installation's current")
  }
)

test.skipIf(!terraformBinary)(
  "a copy taken before another machine's apply is refused",
  () => {
    const t = real(liveState(LINEAGE))
    const x = join(t.directory, "x.tfstate")
    const a = t.own(x, "a")
    reconcile(a)
    const b = t.own(x, "b")
    a.configure(join(t.directory, "y.tfstate"))
    expect(a.init("-migrate-state", "-force-copy")).toBe(0)
    // B applies to X before A records Y.
    apply(t, b, 2)
    expect(() => reconcile(a)).toThrow(
      "does not hold this installation's current"
    )
    expect(current(b)).not.toThrow()
  }
)

test.skipIf(!terraformBinary)(
  "a migrated copy with a new lineage is accepted by its contents, and recorded",
  () => {
    const t = real(liveState(LINEAGE))
    const x = join(t.directory, "x.tfstate")
    const a = t.own(x, "a")
    reconcile(a)
    // Some backends give a migrated state a new lineage.
    const y = join(t.directory, "y.tfstate")
    writeFileSync(
      y,
      JSON.stringify({ ...t.read(x), lineage: "lineage-new", serial: 1 })
    )
    a.configure(y)
    expect(a.init("-reconfigure")).toBe(0)
    expect(reconcile(a).action).toBe("record")
    expect(pointerIn(t.read(t.bucketPath)).lineage).toBe("lineage-new")
    apply(t, a, 2)
    const b = t.own(x, "b")
    expect(current(b)).toThrow("does not hold this installation's current")
  }
)

test.skipIf(!terraformBinary)(
  "a migration that stopped before the pointer finishes on the next init",
  () => {
    const t = real(liveState(LINEAGE))
    const a = t.own(join(t.directory, "x.tfstate"), "a")
    reconcile(a)
    a.configure(join(t.directory, "y.tfstate"))
    expect(a.init("-migrate-state", "-force-copy")).toBe(0)
    // No reconcile here: the process stopped. The next init picks it up.
    expect(a.init()).toBe(0)
    expect(() => reconcile(a)).not.toThrow()
    expect(current(a)).not.toThrow()
  }
)

test.skipIf(!terraformBinary)(
  "init -reconfigure onto an empty backend is refused, and so is every command after it",
  () => {
    const t = real(liveState(LINEAGE))
    const own = t.own(join(t.directory, "x.tfstate"))
    reconcile(own)
    own.configure(join(t.directory, "z.tfstate"))
    expect(own.init("-reconfigure")).toBe(0)
    expect(() => reconcile(own)).toThrow(
      "does not hold this installation's current"
    )
    expect(current(own)).toThrow("does not hold this installation's current")
  }
)

test.skipIf(!terraformBinary)(
  "a new installation's backend gets a lineage of its own; no other empty backend passes for it",
  () => {
    const t = real()
    const ownPath = join(t.directory, "own.tfstate")
    const own = t.own(ownPath)
    expect(reconcile(own).action).toBe("record")
    const seeded = t.read(ownPath)
    expect(seeded.resources).toEqual([])
    expect(pointerIn(t.read(t.bucketPath)).lineage).toBe(seeded.lineage)
    expect(current(own)).not.toThrow()
    const other = t.own(join(t.directory, "other.tfstate"), "other")
    expect(current(other)).toThrow("does not hold this installation's current")
    // A first apply that failed half way and never recorded its result:
    // the writer stays, and an empty backend is still refused.
    beginOwnWrite(own.files, own.runs, "operation-1")
    const partial = join(t.directory, "partial.tfstate")
    writeFileSync(
      partial,
      JSON.stringify({
        ...liveState(seeded.lineage),
        serial: seeded.serial + 1,
      })
    )
    expect(own.run(["state", "push", partial]).status).toBe(0)
    own.configure(join(t.directory, "empty.tfstate"))
    expect(own.init("-reconfigure")).toBe(0)
    expect(current(own)).toThrow("did not record the result")
    expect(current(other)).toThrow("did not record the result")
    own.configure(ownPath)
    expect(own.init("-reconfigure")).toBe(0)
    expect(current(own)).not.toThrow()
    expect(reconcile(own).action).toBe("record")
    const recorded = pointerIn(t.read(t.bucketPath))
    expect(recorded.writer).toBeNull()
    expect(recorded.digest).toBe(digestOf(t.read(ownPath)))
    expect(recorded.digest).not.toBe(digestOf(seeded))
  }
)

test.skipIf(!terraformBinary)(
  "a result that could not be recorded keeps every other copy out until it is",
  () => {
    const t = real(liveState(LINEAGE))
    const x = join(t.directory, "x.tfstate")
    const a = t.own(x, "a")
    reconcile(a)
    // B holds a copy of the same state elsewhere.
    const y = join(t.directory, "y.tfstate")
    writeFileSync(y, readFileSync(x))
    const b = t.own(y, "b")
    expect(current(b)).not.toThrow()
    // A changes X, and recording it in the bucket fails once.
    let fail = false
    const flaky: TerraformRun = (args, options) =>
      fail && args[0] === "state" && args[1] === "push"
        ? { status: 1, stdout: "" }
        : t.bucket.run(args, options)
    beginOwnWrite(a.files, { ...a.runs, bucket: flaky }, "operation-1")
    apply(t, { ...a, runs: a.runs }, 2)
    expect(current(b)).toThrow("does not hold this installation's current")
    beginOwnWrite(a.files, a.runs, "operation-2")
    const pulled = JSON.parse(
      a.run(["state", "pull"], { capture: true }).stdout
    )
    const next = join(t.directory, "next.tfstate")
    writeFileSync(
      next,
      JSON.stringify({
        ...pulled,
        serial: pulled.serial + 1,
        outputs: { ...pulled.outputs, version: { value: 3, type: "number" } },
      })
    )
    expect(a.run(["state", "push", next]).status).toBe(0)
    fail = true
    expect(() => finishOwnWrite(a.files, { ...a.runs, bucket: flaky })).toThrow(
      "Terraform could not write the state bucket"
    )
    fail = false
    // The writer stays: B's copy is refused, even though its serial and
    // contents are those the pointer last recorded.
    expect(current(b)).toThrow("did not record the result")
    expect(current(b, "operation-other")).toThrow("did not record the result")
    // The next init where it ran records it.
    expect(current(a)).not.toThrow()
    expect(reconcile(a).action).toBe("record")
    expect(pointerIn(t.read(t.bucketPath)).writer).toBeNull()
    expect(current(b)).toThrow("does not hold this installation's current")
    // Or, once that run is confirmed stopped, another machine takes it over.
    beginOwnWrite(a.files, a.runs, "operation-3")
    const c = t.own(x, "c")
    expect(current(c)).toThrow("did not record the result")
    expect(current(c, "operation-3")).not.toThrow()
    expect(reconcile(c, "operation-3").action).toBe("record")
  }
)

test.skipIf(!terraformBinary)(
  "a change to an accepted copy of another lineage is recorded, and the other copy is refused",
  () => {
    const t = real(liveState(LINEAGE))
    const y = join(t.directory, "y.tfstate")
    const a = t.own(y, "a")
    reconcile(a)
    // The old copy X has the same contents under another lineage.
    const x = join(t.directory, "x.tfstate")
    writeFileSync(
      x,
      JSON.stringify({ ...t.read(y), lineage: "lineage-old", serial: 1 })
    )
    const b = t.own(x, "b")
    expect(current(b)).not.toThrow()
    apply(t, b, 2)
    expect(pointerIn(t.read(t.bucketPath))).toMatchObject({
      lineage: "lineage-old",
      writer: null,
    })
    expect(current(b)).not.toThrow()
    expect(current(a)).toThrow("does not hold this installation's current")
  }
)

test.skipIf(!terraformBinary)(
  "a tainted instance is part of the state: an untainted copy is refused",
  () => {
    const t = real(liveState(LINEAGE))
    const x = join(t.directory, "x.tfstate")
    const a = t.own(x, "a")
    reconcile(a)
    const y = join(t.directory, "y.tfstate")
    writeFileSync(
      y,
      JSON.stringify({ ...t.read(x), lineage: "lineage-copy", serial: 1 })
    )
    const b = t.own(y, "b")
    expect(current(b)).not.toThrow()
    beginOwnWrite(a.files, a.runs, "operation-1")
    expect(a.run(["taint", "terraform_data.api"]).status).toBe(0)
    finishOwnWrite(a.files, a.runs)
    expect(t.read(x).resources[0].instances[0].status).toBe("tainted")
    expect(current(b)).toThrow("does not hold this installation's current")
  }
)

test.skipIf(!terraformBinary)(
  "an installation without a state never adopts a backend that holds one",
  () => {
    const t = real()
    const foreign = join(t.directory, "foreign.tfstate")
    writeFileSync(foreign, JSON.stringify(liveState("other-installation")))
    const own = t.own(foreign)
    expect(() => reconcile(own)).toThrow("already holds a state")
    expect(t.read(t.bucketPath)).toBeUndefined()
    expect(t.read(foreign).lineage).toBe("other-installation")
  }
)

test.skipIf(!terraformBinary)(
  "an own backend holding another state than the bucket's is never written",
  () => {
    const t = real(liveState(LINEAGE))
    const foreign = join(t.directory, "foreign.tfstate")
    writeFileSync(
      foreign,
      JSON.stringify({ ...liveState("other-installation"), resources: [] })
    )
    const own = t.own(foreign)
    expect(() => reconcile(own)).toThrow("already holds a different state")
    expect(t.read(foreign).lineage).toBe("other-installation")
    expect(t.read(t.bucketPath).resources).toHaveLength(1)
  }
)

test.skipIf(!terraformBinary)(
  "a state already moved with Terraform is recorded as it is, and a leftover local copy moves aside",
  () => {
    const t = real(liveState(LINEAGE))
    writeFileSync(t.files.state, JSON.stringify(liveState(LINEAGE)))
    const ownPath = join(t.directory, "own.tfstate")
    writeFileSync(ownPath, JSON.stringify(liveState(LINEAGE)))
    const own = t.own(ownPath)
    const done = reconcile(own)
    expect(done.action).toBe("record")
    expect(existsSync(t.files.state)).toBe(false)
    expect(t.read(ownPath).resources).toHaveLength(1)
    expect(pointerIn(t.read(t.bucketPath)).lineage).toBe(LINEAGE)
  }
)
