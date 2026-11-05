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
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { instanceTerraform, type InstanceTerraform } from "./instance"
import {
  assertOwnCurrent,
  assertStateHere,
  backendIdentity,
  declaredBackend,
  ownBackend,
  ownBackendFile,
  POINTER_OUTPUT,
  reconcileOwnBackend,
  recordFirstState,
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

test("a backend is identified by its configuration hash and workspace; a local one by this machine and its path", () => {
  const directory = temporary()
  const own = { root: join(directory, "root"), data: join(directory, "data") }
  expect(backendIdentity(own)).toBeUndefined()
  mkdirSync(own.data, { recursive: true })
  const record = (backend: object) =>
    writeFileSync(
      join(own.data, "terraform.tfstate"),
      JSON.stringify({ backend })
    )
  record({
    type: "s3",
    config: { bucket: "a", access_key: "secret" },
    hash: 42,
  })
  expect(backendIdentity(own)).toBe("s3 42 default")
  writeFileSync(join(own.data, "environment"), "blue")
  expect(backendIdentity(own)).toBe("s3 42 blue")
  record({ type: "local", config: { path: "../x.tfstate" }, hash: 7 })
  expect(backendIdentity(own)).toBe(
    `local ${hostname()}:${join(directory, "x.tfstate")} blue`
  )
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
  // What init leaves in the drivers' bucket-state configuration.
  const bucketData = join(files.directory, "bucket-state", ".terraform")
  mkdirSync(bucketData, { recursive: true })
  writeFileSync(join(bucketData, "terraform.tfstate"), "{}")
  const own = (path: string, name = "own") => {
    writeFileSync(
      ownBackendFile(files),
      `terraform {\n  backend "local" {\n    path = ${JSON.stringify(path)}\n  }\n}\n`
    )
    const backend = localBackend(directory, name, path)
    expect(backend.init()).toBe(0)
    return {
      ...backend,
      runs: { bucket: bucket.run, own: backend.run } as Runs,
    }
  }
  const read = (path: string) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined
  return { files, directory, bucketPath, bucket, own, read }
}
const pointerIn = (state: { outputs: Record<string, { value: string }> }) =>
  JSON.parse(state.outputs[POINTER_OUTPUT].value)
const reconcile = (
  files: InstanceTerraform,
  own: { where: OwnBackend; runs: Runs },
  previous?: string
) =>
  reconcileOwnBackend(files, own.runs, {
    write: true,
    identity: backendIdentity(own.where) ?? "",
    previous,
  })

test.skipIf(!terraformBinary)(
  "init moves the bucket's state into an empty own backend, then leaves only a pointer to it",
  () => {
    const t = real(liveState(LINEAGE))
    const ownPath = join(t.directory, "own.tfstate")
    const own = t.own(ownPath)
    expect(
      reconcileOwnBackend(t.files, own.runs, {
        write: false,
        identity: backendIdentity(own.where) ?? "",
      }).action
    ).toBe("move")
    expect(existsSync(ownPath)).toBe(false)
    const done = reconcile(t.files, own)
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
      identity: backendIdentity(own.where),
      lineage: LINEAGE,
    })
    expect(reconcile(t.files, own)).toEqual({ action: "none" })
    expect(() =>
      assertOwnCurrent(t.files, own.where, own.runs, "init")
    ).not.toThrow()
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
    expect(() => reconcile(t.files, own)).toThrow(
      "is the state bucket's own state"
    )
    expect(t.read(t.bucketPath).resources).toEqual(liveState(LINEAGE).resources)
  }
)

test.skipIf(!terraformBinary)(
  "a local state moving into an own backend that is the bucket is refused before the local file moves",
  () => {
    const t = real()
    writeFileSync(t.files.state, JSON.stringify(liveState(LINEAGE)))
    const own = t.own(t.bucketPath)
    expect(() => reconcile(t.files, own)).toThrow(
      "is the state bucket's own state"
    )
    expect(existsSync(t.files.state)).toBe(true)
    expect(t.read(t.bucketPath).resources).toHaveLength(1)
  }
)

test.skipIf(!terraformBinary)(
  "after init -migrate-state to another backend, a machine still on the old one is refused",
  () => {
    const t = real(liveState(LINEAGE))
    const x = join(t.directory, "x.tfstate")
    const a = t.own(x, "a")
    reconcile(t.files, a)
    // Machine B joins on X.
    const b = t.own(x, "b")
    expect(() =>
      assertOwnCurrent(t.files, b.where, b.runs, "init")
    ).not.toThrow()
    // Machine A moves the state on to Y with Terraform.
    const previous = backendIdentity(a.where)
    a.configure(join(t.directory, "y.tfstate"))
    expect(a.init("-migrate-state", "-force-copy")).toBe(0)
    expect(reconcile(t.files, a, previous).action).toBe("record")
    expect(pointerIn(t.read(t.bucketPath)).identity).toBe(
      backendIdentity(a.where)
    )
    expect(() =>
      assertOwnCurrent(t.files, a.where, a.runs, "init")
    ).not.toThrow()
    // X still holds the old copy with the same lineage; B is refused.
    expect(t.read(x).lineage).toBe(LINEAGE)
    expect(() => assertOwnCurrent(t.files, b.where, b.runs, "init")).toThrow(
      "lives in another local backend"
    )
    expect(() => reconcile(t.files, b, backendIdentity(b.where))).toThrow(
      "lives in another local backend"
    )
  }
)

test.skipIf(!terraformBinary)(
  "init -reconfigure onto an empty backend is refused, and so is every command after it",
  () => {
    const t = real(liveState(LINEAGE))
    const own = t.own(join(t.directory, "x.tfstate"))
    reconcile(t.files, own)
    const previous = backendIdentity(own.where)
    own.configure(join(t.directory, "z.tfstate"))
    expect(own.init("-reconfigure")).toBe(0)
    expect(() => reconcile(t.files, own, previous)).toThrow(
      "does not hold this installation's state"
    )
    expect(() =>
      assertOwnCurrent(t.files, own.where, own.runs, "init")
    ).toThrow("lives in another local backend")
  }
)

test.skipIf(!terraformBinary)(
  "a new installation is bound to its empty backend; its first state is recorded and other backends are refused",
  () => {
    const t = real()
    const own = t.own(join(t.directory, "own.tfstate"))
    expect(reconcile(t.files, own).action).toBe("record")
    expect(pointerIn(t.read(t.bucketPath))).toMatchObject({ lineage: null })
    // Another machine with another empty backend is refused.
    const other = t.own(join(t.directory, "other.tfstate"), "other")
    expect(() =>
      assertOwnCurrent(t.files, other.where, other.runs, "init")
    ).toThrow("lives in another local backend")
    // The first apply writes the state; the pointer records its lineage.
    const applied = join(t.directory, "applied.tfstate")
    writeFileSync(applied, JSON.stringify(liveState(LINEAGE, 1)))
    t.own(join(t.directory, "own.tfstate"))
    expect(own.run(["state", "push", applied]).status).toBe(0)
    recordFirstState(t.files, own.where, own.runs)
    expect(pointerIn(t.read(t.bucketPath)).lineage).toBe(LINEAGE)
    expect(reconcile(t.files, own)).toEqual({ action: "none" })
  }
)

test.skipIf(!terraformBinary)(
  "an installation without a state never adopts a backend that holds one",
  () => {
    const t = real()
    const foreign = join(t.directory, "foreign.tfstate")
    writeFileSync(foreign, JSON.stringify(liveState("other-installation")))
    const own = t.own(foreign)
    expect(() => reconcile(t.files, own)).toThrow("already holds a state")
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
    expect(() => reconcile(t.files, own)).toThrow(
      "already holds a different state"
    )
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
    const done = reconcile(t.files, own)
    expect(done.action).toBe("record")
    expect(existsSync(t.files.state)).toBe(false)
    expect(t.read(ownPath).resources).toHaveLength(1)
    expect(pointerIn(t.read(t.bucketPath)).lineage).toBe(LINEAGE)
  }
)
