/**
 * A stand-in Azad app source checkout for tests: a Git repository with the
 * scripts/self-host entrypoints the drivers require. Its settings.ts speaks
 * the real protocol (JSON on stdin and stdout, exit 65 for a refused setting)
 * with fixed answers, and records each call in `calls.jsonl`.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SETTINGS_ENTRY = `const [command, ...args] = process.argv.slice(2)
const input = command === "resource-names" ? undefined : await Bun.stdin.text()
const settings = input ? JSON.parse(input) : {}
const { appendFileSync } = await import("node:fs")
appendFileSync(new URL("../../calls.jsonl", import.meta.url), JSON.stringify({ command, args, keys: Object.keys(settings).sort() }) + "\\n")
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
  process.stderr.write("Usage: settings.ts resource-names|storage|validate")
  process.exit(64)
}
`

/** Creates the checkout in `directory` and returns its path and HEAD. */
export function fakeSource(directory: string): {
  path: string
  revision: string
} {
  const path = join(directory, "azad-app")
  mkdirSync(join(path, "scripts/self-host"), { recursive: true })
  mkdirSync(join(path, "node_modules"))
  writeFileSync(join(path, "scripts/self-host/settings.ts"), SETTINGS_ENTRY)
  for (const entry of ["cloudflare-install.ts", "celld-install.ts"])
    writeFileSync(join(path, "scripts/self-host", entry), "process.exit(0)\n")
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        path,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git("init", "--quiet")
  git("add", "scripts")
  git("commit", "--quiet", "-m", "fixture")
  return { path, revision: git("rev-parse", "HEAD") }
}
