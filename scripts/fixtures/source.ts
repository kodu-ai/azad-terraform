/**
 * A stand-in unpacked Azad release for tests: a `release.json` and the
 * installer entrypoints in `payload/installer/` the drivers require. Its
 * settings.js speaks the real protocol (JSON on stdin and stdout, exit 65
 * for a refused setting) with fixed answers, and records each call in
 * `calls.jsonl`; its install-store.js hands out one fixed lease, reports a
 * deployed installation unless the release holds a `not-deployed` file, and
 * records each call (with the handoff it got) in `state-calls.jsonl`; its
 * install entrypoints record their arguments, working directory and handoff
 * in `install-calls.jsonl`. Every record also names the working directory
 * the entrypoint ran in.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Release } from "../source"

const RECORD = `const { appendFileSync } = await import("node:fs")
const record = (file, entry) => appendFileSync(new URL("../../" + file, import.meta.url), JSON.stringify({ ...entry, cwd: process.cwd() }) + "\\n")
`

const SETTINGS_ENTRY = `${RECORD}const [command, ...args] = process.argv.slice(2)
const input = command === "resource-names" ? undefined : await Bun.stdin.text()
const settings = input ? JSON.parse(input) : {}
record("calls.jsonl", { command, args, keys: Object.keys(settings).sort() })
if (command === "resource-names") {
  process.stdout.write(JSON.stringify({ prefix: "azad-fixture-prefix" }))
} else if (command === "storage") {
  process.stdout.write(JSON.stringify(settings.STORAGE_ADAPTER === "gcs" ? { kind: "gcs", bucket: settings.STORAGE_BUCKET, releasesBucket: settings.STORAGE_BUCKET, endpoint: null, region: null } : { kind: "r2" }))
} else if (command === "validate") {
  if (settings.FIXTURE_REFUSE) {
    process.stderr.write("FIXTURE_REFUSE must be unset.")
    process.exit(65)
  }
} else {
  process.stderr.write("Usage: settings.js resource-names|storage|validate")
  process.exit(64)
}
`

const INSTALL_STORE_ENTRY = `${RECORD}const [command, ...args] = process.argv.slice(2)
const stdin = command === "publish" ? JSON.parse(await Bun.stdin.text()) : undefined
record("state-calls.jsonl", { command, args, state: JSON.parse(process.env.AZAD_INSTALL_STATE ?? "null"), stdin })
if (command === "acquire") process.stdout.write(JSON.stringify({ id: "operation-fixture", version: "1" }))
if (command === "backup") process.stdout.write(args[args.indexOf("--out") + 1])
if (command === "deployed") process.stdout.write((await Bun.file(new URL("../../not-deployed", import.meta.url)).exists()) ? "false" : "true")
`

const installEntry = (
  name: string
) => `${RECORD}record("install-calls.jsonl", { entry: ${JSON.stringify(name)}, args: process.argv.slice(2), handoff: JSON.parse(process.env.AZAD_TERRAFORM_INSTALL ?? process.env.AZAD_CELLD_INSTALL ?? "null") })
process.stdout.write(${JSON.stringify(`${name} ran\n`)})
`

/** The fixture release's version and the app commit it was built from. */
export const FIXTURE_RELEASE = {
  version: "4.497.0",
  revision: "f".repeat(40),
}

/** Creates the release in `directory`/azad-release and returns it as the drivers read it. */
export function fakeRelease(
  directory: string,
  manifest: { version?: string; revision?: string } = {}
): Release {
  const path = join(directory, "azad-release")
  const payload = join(path, "payload")
  const installer = join(payload, "installer")
  const version = manifest.version ?? FIXTURE_RELEASE.version
  const revision = manifest.revision ?? FIXTURE_RELEASE.revision
  mkdirSync(installer, { recursive: true })
  mkdirSync(join(path, "web"))
  writeFileSync(
    join(path, "release.json"),
    JSON.stringify({
      format: 1,
      version,
      sourceSha: revision,
      signed: false,
      agentConnect: { version: "0.46.0" },
    })
  )
  writeFileSync(join(installer, "settings.js"), SETTINGS_ENTRY)
  writeFileSync(join(installer, "install-store.js"), INSTALL_STORE_ENTRY)
  for (const name of ["cloudflare-install", "celld-install"])
    writeFileSync(join(installer, `${name}.js`), installEntry(name))
  return { path, payload, version, revision }
}
