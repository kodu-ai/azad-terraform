import { afterEach, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeRelease, FIXTURE_RELEASE } from "./fixtures/source"
import {
  installer,
  ReleaseError,
  requireRelease,
  SettingsRefused,
  sourceSettings,
} from "./source"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "azad-release-"))
  directories.push(directory)
  return directory
}

/** The calls the fake release's settings entrypoint recorded. */
function calls(path: string) {
  return readFileSync(join(path, "calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("a release comes from --release, else AZAD_RELEASE, and binds to its sourceSha and version", () => {
  const release = fakeRelease(temporary())
  expect(requireRelease(release.path, {})).toEqual({
    path: release.path,
    payload: join(release.path, "payload"),
    version: FIXTURE_RELEASE.version,
    revision: FIXTURE_RELEASE.revision,
  })
  expect(requireRelease(undefined, { AZAD_RELEASE: release.path })).toEqual(
    release
  )
  expect(() => requireRelease(undefined, {})).toThrow(ReleaseError)
  expect(() => requireRelease(undefined, {})).toThrow("--release is required")
})

test("anything but an unpacked release with its four installer entrypoints is refused", () => {
  const directory = temporary()
  expect(() => requireRelease(join(directory, "missing"), {})).toThrow(
    "does not exist"
  )
  mkdirSync(join(directory, "plain"))
  expect(() => requireRelease(join(directory, "plain"), {})).toThrow(
    "has no release.json"
  )
  const release = fakeRelease(directory)
  const manifest = join(release.path, "release.json")
  const valid = readFileSync(manifest, "utf8")
  for (const broken of [
    "not json",
    JSON.stringify({ ...JSON.parse(valid), format: 2 }),
    JSON.stringify({ ...JSON.parse(valid), sourceSha: "HEAD" }),
    JSON.stringify({ ...JSON.parse(valid), signed: undefined }),
  ]) {
    writeFileSync(manifest, broken)
    expect(() => requireRelease(release.path, {})).toThrow(
      "is not a release manifest this version reads"
    )
  }
  writeFileSync(
    manifest,
    JSON.stringify({ ...JSON.parse(valid), signed: true, agentConnect: null })
  )
  expect(requireRelease(release.path, {}).revision).toBe(
    FIXTURE_RELEASE.revision
  )
  rmSync(installer(release, "celld-install"))
  rmSync(installer(release, "settings"))
  expect(() => requireRelease(release.path, {})).toThrow(
    "lacks payload/installer/settings.js, payload/installer/celld-install.js"
  )
})

test("setup asks the release's settings entrypoint from its payload, with the settings on stdin", () => {
  const release = fakeRelease(temporary())
  const app = sourceSettings(release)
  expect(app.resourcePrefix("https://api.board.example.com")).toBe(
    "azad-fixture-prefix"
  )
  expect(app.storage({ STORAGE_ADAPTER: "" })).toEqual({ kind: "r2" })
  expect(
    app.storage({ STORAGE_ADAPTER: "gcs", STORAGE_BUCKET: "customer-files" })
  ).toEqual({
    kind: "gcs",
    bucket: "customer-files",
    releasesBucket: "customer-files",
    endpoint: undefined,
    region: undefined,
  })
  app.validate("celld", { CLERK_SECRET_KEY: "sk_test_fixture" })
  const cwd = release.payload
  expect(calls(release.path)).toEqual([
    {
      command: "resource-names",
      args: ["--api-origin", "https://api.board.example.com"],
      keys: [],
      cwd,
    },
    { command: "storage", args: [], keys: ["STORAGE_ADAPTER"], cwd },
    {
      command: "storage",
      args: [],
      keys: ["STORAGE_ADAPTER", "STORAGE_BUCKET"],
      cwd,
    },
    { command: "validate", args: ["celld"], keys: ["CLERK_SECRET_KEY"], cwd },
  ])
})

test("a refused setting carries the app's reason; a broken entrypoint names itself", () => {
  const release = fakeRelease(temporary())
  const app = sourceSettings(release)
  expect(() =>
    app.validate("cloudflare", { FIXTURE_REFUSE: "secret-value" })
  ).toThrow(new SettingsRefused("FIXTURE_REFUSE must be unset."))
  writeFileSync(
    installer(release, "settings"),
    "process.stdout.write('not json')\n"
  )
  expect(() => app.resourcePrefix("https://api.board.example.com")).toThrow(
    "unexpected resource names"
  )
  writeFileSync(
    installer(release, "settings"),
    "throw new Error('broken release')\n"
  )
  expect(() => app.validate("cloudflare", {})).toThrow(ReleaseError)
  expect(() => app.validate("cloudflare", {})).toThrow("broken release")
})
