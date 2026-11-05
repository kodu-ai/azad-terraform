import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { instanceTerraform } from "./instance"
import {
  assertStateHere,
  declaredBackend,
  ownBackend,
  ownBackendFile,
  POINTER_OUTPUT,
  reconcileOwnBackend,
} from "./own-backend"
import type { TerraformRun } from "./state"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function instance(root: "postgres" | "gcp-celld" = "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "azad-terraform-own-"))
  directories.push(directory)
  const files = instanceTerraform(join(directory, "instance"), root)
  mkdirSync(files.directory, { recursive: true })
  return files
}

const S3 = 'terraform {\n  backend "s3" {\n    bucket = "team-state"\n  }\n}\n'

/**
 * A backend as `state pull` and `state push` see it: a push needs the
 * stored lineage and a higher serial unless forced, as Terraform checks.
 */
function backend(initial?: object) {
  let stored = initial ? JSON.stringify(initial) : ""
  const pushes: string[] = []
  const run: TerraformRun = (args) => {
    if (args[0] === "version")
      return { status: 0, stdout: '{"terraform_version":"1.17.1"}' }
    if (args[0] === "state" && args[1] === "pull")
      return { status: 0, stdout: stored }
    if (args[0] === "state" && args[1] === "push") {
      const next = JSON.parse(readFileSync(args.at(-1) ?? "", "utf8"))
      const current = stored ? JSON.parse(stored) : undefined
      if (
        !args.includes("-force") &&
        current &&
        (current.lineage !== next.lineage || current.serial >= next.serial)
      )
        return { status: 1, stdout: "" }
      stored = JSON.stringify(next)
      pushes.push(stored)
      return { status: 0, stdout: "" }
    }
    return { status: 1, stdout: "" }
  }
  return {
    run,
    state: () => (stored ? JSON.parse(stored) : undefined),
    pushes,
  }
}

const installation = {
  version: 4,
  terraform_version: "1.13.4",
  serial: 12,
  lineage: "lineage-install",
  resources: [{ type: "cloudflare_worker", name: "api" }],
  outputs: { deploy: { value: { fleets: 1 }, type: "object" } },
}
const pointerOf = (state: { outputs: Record<string, { value: string }> }) =>
  JSON.parse(state.outputs[POINTER_OUTPUT].value)
const now = new Date("2026-11-05T21:00:00Z")

test("without a backend_override.tf Terraform keeps running in this release's root", () => {
  expect(ownBackend(instance())).toBeUndefined()
})

test("the override runs in a copy of this release's root and modules, refreshed only when either changes", () => {
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
  const copied = statSync(join(root, "main.tf")).ino
  ownBackend(files)
  expect(statSync(join(root, "main.tf")).ino).toBe(copied)
  const cloud =
    'terraform {\n  cloud {\n    organization = "team"\n    workspaces {\n      name = "azad"\n    }\n  }\n}\n'
  writeFileSync(ownBackendFile(files), cloud)
  ownBackend(files)
  expect(readFileSync(join(root, "backend_override.tf"), "utf8")).toBe(cloud)
  expect(declaredBackend(files)).toBe("cloud")
})

test("the backend type comes from the operator's file", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  expect(declaredBackend(files)).toBe("s3")
  writeFileSync(ownBackendFile(files), "# nothing here\n")
  expect(() => declaredBackend(files)).toThrow("declares no backend")
})

test("init moves the bucket's state into an empty own backend, then leaves only a pointer", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  const bucket = backend(installation)
  const own = backend()
  const runs = { bucket: bucket.run, own: own.run }
  expect(reconcileOwnBackend(files, runs, { write: false })).toEqual({
    action: "move",
    kept: [],
  })
  // A dry run writes nothing.
  expect(own.state()).toBeUndefined()
  const done = reconcileOwnBackend(files, runs, { write: true, now })
  const kept = `${files.state}.before-own-backend-2026-11-05T21-00-00-000Z`
  expect(done).toEqual({ action: "move", kept: [kept] })
  expect(own.state().resources).toEqual(installation.resources)
  expect(own.state().outputs).toEqual(installation.outputs)
  expect(JSON.parse(readFileSync(kept, "utf8"))).toEqual(installation)
  expect(statSync(kept).mode & 0o777).toBe(0o600)
  // The bucket keeps its lineage, with nothing in it but the pointer.
  const pointer = bucket.state()
  expect(pointer.lineage).toBe(installation.lineage)
  expect(pointer.serial).toBe(installation.serial + 1)
  expect(pointer.resources).toEqual([])
  expect(pointerOf(pointer)).toMatchObject({
    backend: "s3",
    lineage: installation.lineage,
    at: now.toISOString(),
  })
  // Nothing is left behind, and a second init changes nothing.
  expect(readdirSync(files.directory).filter((n) => n.startsWith("."))).toEqual(
    []
  )
  expect(reconcileOwnBackend(files, runs, { write: true })).toEqual({
    action: "none",
  })
})

test("a state already moved with Terraform is kept and recorded", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  const bucket = backend(installation)
  const own = backend({ ...installation, serial: 13 })
  const runs = { bucket: bucket.run, own: own.run }
  const done = reconcileOwnBackend(files, runs, { write: true, now })
  expect(done).toEqual({
    action: "record",
    kept: [`${files.state}.before-own-backend-2026-11-05T21-00-00-000Z`],
  })
  expect(own.pushes).toEqual([])
  expect(pointerOf(bucket.state()).lineage).toBe(installation.lineage)
})

test("an own backend holding another state is never written, and the bucket keeps the installation's", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  const bucket = backend(installation)
  const own = backend({
    ...installation,
    lineage: "lineage-other",
    resources: [{ type: "google_sql_database_instance", name: "other" }],
  })
  expect(() =>
    reconcileOwnBackend(
      files,
      { bucket: bucket.run, own: own.run },
      { write: true }
    )
  ).toThrow("already holds a different state")
  expect(bucket.state()).toEqual(installation)
  expect(own.pushes).toEqual([])
})

test("once moved, only the backend holding the installation's lineage is accepted", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  const bucket = backend(installation)
  const own = backend()
  reconcileOwnBackend(
    files,
    { bucket: bucket.run, own: own.run },
    {
      write: true,
    }
  )
  const moved = bucket.state()
  // Later applies change the state; its lineage stays.
  const applied = backend({ ...own.state(), serial: 40, resources: [] })
  expect(
    reconcileOwnBackend(
      files,
      { bucket: bucket.run, own: applied.run },
      { write: true }
    )
  ).toEqual({ action: "none" })
  // A new, empty backend (a changed file without init -migrate-state) is refused.
  for (const other of [
    backend(),
    backend({ version: 4, serial: 1, lineage: "gcs-generated", resources: [] }),
  ])
    expect(() =>
      reconcileOwnBackend(
        files,
        { bucket: bucket.run, own: other.run },
        { write: true }
      )
    ).toThrow("does not hold this installation's state")
  expect(bucket.state()).toEqual(moved)
})

test("a new installation starts in its own backend; its first state is recorded", () => {
  const files = instance("gcp-celld")
  writeFileSync(ownBackendFile(files), 'terraform {\n  backend "gcs" {}\n}\n')
  // A fresh GCS prefix answers with an empty state of its own lineage.
  const bucket = backend({
    version: 4,
    serial: 0,
    lineage: "",
    resources: [],
  })
  const own = backend()
  const runs = { bucket: bucket.run, own: own.run }
  expect(reconcileOwnBackend(files, runs, { write: true })).toEqual({
    action: "record",
    kept: [],
  })
  const recorded = bucket.state()
  expect(pointerOf(recorded)).toMatchObject({ backend: "gcs", lineage: null })
  expect(recorded.lineage).not.toBe("")
  expect(recorded.terraform_version).toBe("1.17.1")
  expect(reconcileOwnBackend(files, runs, { write: true })).toEqual({
    action: "none",
  })
  // The first apply writes the installation's state there.
  const applied = backend({ ...installation, lineage: "lineage-new" })
  expect(
    reconcileOwnBackend(
      files,
      { bucket: bucket.run, own: applied.run },
      { write: true }
    )
  ).toEqual({ action: "record", kept: [] })
  expect(pointerOf(bucket.state()).lineage).toBe("lineage-new")
})

test("a local state of a release before 0.1.0 moves straight into the own backend", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  writeFileSync(files.state, JSON.stringify(installation))
  const bucket = backend()
  const own = backend()
  const done = reconcileOwnBackend(
    files,
    { bucket: bucket.run, own: own.run },
    { write: true, now }
  )
  const kept = `${files.state}.before-remote-2026-11-05T21-00-00-000Z`
  expect(done).toEqual({ action: "move", kept: [kept] })
  expect(existsSync(files.state)).toBe(false)
  expect(own.state().resources).toEqual(installation.resources)
  expect(pointerOf(bucket.state()).lineage).toBe(installation.lineage)
})

test("a local state and a bucket state that disagree are left alone", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  writeFileSync(files.state, JSON.stringify(installation))
  const bucket = backend({
    ...installation,
    resources: [],
    outputs: { x: { value: 1, type: "number" } },
  })
  const own = backend()
  expect(() =>
    reconcileOwnBackend(
      files,
      { bucket: bucket.run, own: own.run },
      { write: true }
    )
  ).toThrow("hold different states")
  expect(own.pushes).toEqual([])
  expect(existsSync(files.state)).toBe(true)
})

test("an own backend that is the bucket itself is refused", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  const bucket = backend(installation)
  const own = backend()
  reconcileOwnBackend(
    files,
    { bucket: bucket.run, own: own.run },
    {
      write: true,
    }
  )
  expect(() =>
    reconcileOwnBackend(
      files,
      { bucket: bucket.run, own: bucket.run },
      { write: true }
    )
  ).toThrow("holds the state bucket's pointer")
})

test("without its backend_override.tf, a moved installation refuses to plan against the bucket", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  const bucket = backend(installation)
  expect(() => assertStateHere(bucket.run, files, "init")).not.toThrow()
  expect(() => assertStateHere(backend().run, files, "init")).not.toThrow()
  reconcileOwnBackend(
    files,
    { bucket: bucket.run, own: backend().run },
    {
      write: true,
    }
  )
  expect(() => assertStateHere(bucket.run, files, "the init command")).toThrow(
    "keeps Terraform's state in its own s3 backend"
  )
  expect(() => assertStateHere(bucket.run, files, "the init command")).toThrow(
    `Put its backend_override.tf back in ${files.directory}`
  )
})

test("a state already in the own backend still moves a leftover local copy aside", () => {
  const files = instance()
  writeFileSync(ownBackendFile(files), S3)
  writeFileSync(files.state, JSON.stringify(installation))
  const done = reconcileOwnBackend(
    files,
    { bucket: backend(installation).run, own: backend(installation).run },
    { write: true, now }
  )
  expect(done.action).toBe("record")
  expect(done.action !== "none" && done.kept).toContain(
    `${files.state}.before-remote-2026-11-05T21-00-00-000Z`
  )
  expect(existsSync(files.state)).toBe(false)
})
