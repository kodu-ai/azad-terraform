/**
 * A `terraform` on PATH for driver tests that read states. `state pull`
 * answers, in turn, the states queued for the configuration it runs in:
 * `bucket-state` (the drivers' bucket configuration) or `root` (any other);
 * the last one keeps answering, and none answers with nothing. Every other
 * command is recorded with its working data and the R2 key it got.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function stateTerraform(directory: string) {
  const bin = join(directory, "state-bin")
  mkdirSync(bin, { recursive: true })
  const queue = (name: string) => join(directory, `${name}.states.json`)
  const log = join(directory, "terraform-calls.jsonl")
  writeFileSync(
    join(bin, "terraform"),
    `#!/usr/bin/env -S bun --no-env-file
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args[1] === "state" && args[2] === "pull") {
  const name = args[0].endsWith("bucket-state") ? "bucket-state" : "root"
  const path = ${JSON.stringify(directory)} + "/" + name + ".states.json"
  const states = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []
  if (states.length) process.stdout.write(JSON.stringify(states[0]))
  if (states.length > 1) writeFileSync(path, JSON.stringify(states.slice(1)))
  process.exit(0)
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, data: process.env.TF_DATA_DIR, r2Key: process.env.AWS_ACCESS_KEY_ID ?? null }) + "\\n")
`,
    { mode: 0o755 }
  )
  return {
    path: `${bin}:${process.env.PATH}`,
    answer(name: "bucket-state" | "root", ...states: object[]) {
      writeFileSync(queue(name), JSON.stringify(states))
    },
    calls(): { args: string[]; data: string; r2Key: string | null }[] {
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    },
  }
}

/** The bucket's state once it points at an own backend's state. */
export function pointerState(pointer: {
  backend: string
  lineage: string
  serial: number
}) {
  return {
    version: 4,
    serial: 9,
    lineage: "lineage-bucket",
    resources: [],
    outputs: {
      azad_state_moved: {
        value: JSON.stringify({
          ...pointer,
          digest: "0".repeat(64),
          at: "2026-11-05T21:00:00.000Z",
          by: "laptop",
        }),
        type: "string",
      },
    },
  }
}

/** A state that records one resource. */
export function recordedState(lineage: string) {
  return {
    version: 4,
    serial: 4,
    lineage,
    resources: [{ type: "terraform_data", name: "x" }],
    outputs: {},
  }
}

/** What init leaves in the own backend's and the bucket configuration's working data. */
export function initializeOwnBackend(terraformDirectory: string) {
  for (const [data, record] of [
    [".terraform-own", { backend: { type: "cloud", config: {}, hash: 99 } }],
    [join("bucket-state", ".terraform"), { backend: { type: "s3" } }],
  ] as const) {
    mkdirSync(join(terraformDirectory, data), { recursive: true })
    writeFileSync(
      join(terraformDirectory, data, "terraform.tfstate"),
      JSON.stringify(record)
    )
  }
}
