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
import { fakeSource } from "./fixtures/source"
import {
  requireSource,
  SettingsRefused,
  sourceSettings,
  SourceError,
} from "./source"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "azad-source-"))
  directories.push(directory)
  return directory
}

/** The calls the fake checkout's settings entrypoint recorded. */
function calls(path: string) {
  return readFileSync(join(path, "calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("a source checkout comes from --source, else AZAD_SOURCE, and binds to its HEAD", () => {
  const source = fakeSource(temporary())
  expect(requireSource(source.path, {})).toEqual(source)
  expect(requireSource(undefined, { AZAD_SOURCE: source.path })).toEqual(source)
  expect(() => requireSource(undefined, {})).toThrow(SourceError)
  expect(() => requireSource(undefined, {})).toThrow("--source is required")
})

test("anything but the top level of an Azad source checkout with its dependencies is refused", () => {
  const directory = temporary()
  expect(() => requireSource(join(directory, "missing"), {})).toThrow(
    "does not exist"
  )
  mkdirSync(join(directory, "plain"))
  expect(() => requireSource(join(directory, "plain"), {})).toThrow(
    "is not a Git checkout"
  )
  const source = fakeSource(directory)
  expect(() => requireSource(join(source.path, "scripts"), {})).toThrow(
    "pass the checkout's top-level directory"
  )
  rmSync(join(source.path, "node_modules"), { recursive: true })
  expect(() => requireSource(source.path, {})).toThrow(
    `Run: bun install --frozen-lockfile --cwd ${source.path}`
  )
  rmSync(join(source.path, "scripts/self-host/settings.ts"))
  expect(() => requireSource(source.path, {})).toThrow(
    "lacks scripts/self-host/settings.ts"
  )
})

test("setup asks the source's settings entrypoint, with the settings on stdin", () => {
  const source = fakeSource(temporary())
  const app = sourceSettings(source)
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
  expect(calls(source.path)).toEqual([
    {
      command: "resource-names",
      args: ["--api-origin", "https://api.board.example.com"],
      keys: [],
    },
    { command: "storage", args: [], keys: ["STORAGE_ADAPTER"] },
    {
      command: "storage",
      args: [],
      keys: ["STORAGE_ADAPTER", "STORAGE_BUCKET"],
    },
    { command: "validate", args: ["celld"], keys: ["CLERK_SECRET_KEY"] },
  ])
})

test("a refused setting carries the app's reason; a broken entrypoint names itself", () => {
  const source = fakeSource(temporary())
  const app = sourceSettings(source)
  expect(() =>
    app.validate("cloudflare", { FIXTURE_REFUSE: "secret-value" })
  ).toThrow(new SettingsRefused("FIXTURE_REFUSE must be unset."))
  writeFileSync(
    join(source.path, "scripts/self-host/settings.ts"),
    "process.stdout.write('not json')\n"
  )
  expect(() => app.resourcePrefix("https://api.board.example.com")).toThrow(
    "unexpected resource names"
  )
  writeFileSync(
    join(source.path, "scripts/self-host/settings.ts"),
    "throw new Error('broken checkout')\n"
  )
  expect(() => app.validate("cloudflare", {})).toThrow(SourceError)
  expect(() => app.validate("cloudflare", {})).toThrow("broken checkout")
})
