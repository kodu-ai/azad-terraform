/**
 * One installation's Terraform files live in its instance directory, never in
 * this repository or the app's source checkout, so any copy of the same
 * release drives it and a fresh copy loses nothing:
 *
 *   <instance>/.env                         private settings the deploy reads
 *   <instance>/terraform/<root name>/       one Terraform root's files:
 *     terraform.tfstate, .backup            the local backend's state
 *     terraform.tfvars.json                 the variables setup wrote
 *     *.tfplan                              saved plans
 *     .terraform/                           Terraform's working data (TF_DATA_DIR)
 *     installer-state/, celld-install/      the deploy step's state and keys
 *
 * The drivers (`cloudflare.ts`, `gcp.ts`) run every Terraform command in a
 * root of this repository (`roots/<root name>`) with this directory's
 * backend, working data and variables. The root name keeps one root's state
 * from ever planning with another's configuration.
 */
import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parse } from "dotenv"
import { z } from "zod"

/** This repository: the roots, modules and drivers of one release. */
export const REPOSITORY = resolve(import.meta.dir, "..")

/** The Terraform roots, by the name their instance directory uses. */
export const ROOTS = ["postgres", "cloudsql", "gcp-celld"] as const
export type RootName = (typeof ROOTS)[number]

/** A refusal whose message names paths and setting names, never values. */
export class InstanceError extends Error {
  name = "InstanceError"
}

/** One Terraform root's files inside one instance directory. */
export type InstanceTerraform = {
  /** The root's name: its directory under `roots/` and in the instance. */
  name: RootName
  /** The root's configuration: `roots/<name>` in this repository. */
  root: string
  /** The instance directory. */
  instance: string
  /** `<instance>/terraform/<root name>`. */
  directory: string
  state: string
  vars: string
  /** Terraform's working data (providers, the backend record): `TF_DATA_DIR`. */
  data: string
  /** Non-default workspaces of the local backend; the drivers use none. */
  workspaces: string
  /** `<instance>/.env`, the private settings file of a new installation. */
  settings: string
}

/**
 * The root a `--root` option names, among `allowed`. Only names are accepted:
 * the instance's state directory is named after its root, so a path could
 * pair one root's state with another configuration.
 *
 * @throws InstanceError for a path or an unknown name.
 */
export function rootNamed<T extends RootName>(
  value: string,
  allowed: readonly T[]
): T {
  const name = allowed.find((candidate) => candidate === value)
  if (!name)
    throw new InstanceError(
      `--root takes a root name: ${allowed.join(" or ")}. Paths are not accepted.`
    )
  return name
}

/** Where root `name`'s files for the installation in `instance` live. */
export function instanceTerraform(
  instance: string,
  name: RootName
): InstanceTerraform {
  const base = resolve(instance)
  const directory = join(base, "terraform", name)
  return {
    name,
    root: join(REPOSITORY, "roots", name),
    instance: base,
    directory,
    state: join(directory, "terraform.tfstate"),
    vars: join(directory, "terraform.tfvars.json"),
    data: join(directory, ".terraform"),
    workspaces: join(directory, "workspaces"),
    settings: join(base, ".env"),
  }
}

/** True when `path` is `directory` or inside it. */
export function inside(directory: string, path: string): boolean {
  const offset = relative(resolve(directory), resolve(path))
  return !offset.startsWith("..") && !isAbsolute(offset)
}

/**
 * Refuses variables whose deploy files are relative or inside this
 * repository: Terraform resolves a relative path against the root, which
 * would put the installation's settings or keys into a copy of a release.
 */
export function assertInstancePaths(
  deployment: { env_file: string; state_directory: string },
  vars: string
): void {
  for (const key of ["env_file", "state_directory"] as const)
    if (!isAbsolute(deployment[key]) || inside(REPOSITORY, deployment[key]))
      throw new InstanceError(
        `deployment.${key} in ${vars} must be an absolute path outside ${REPOSITORY}; setup writes one in the instance directory.`
      )
}

/** Environment that points Terraform's working data at the instance. */
export function terraformEnvironment(files: InstanceTerraform) {
  return { TF_DATA_DIR: files.data }
}

/** Commands that read variables, so they get the instance's tfvars. */
const VARIABLE_COMMANDS = new Set([
  "plan",
  "apply",
  "destroy",
  "import",
  "console",
])
/** Flags whose value may follow as the next argument. */
const VALUE_FLAGS = new Set([
  "-out",
  "-target",
  "-replace",
  "-var",
  "-var-file",
  "-lock-timeout",
  "-parallelism",
  "-generate-config-out",
])

/** Index of the saved plan an `apply` or `show` names, if it names one. */
function planArgument(command: string, args: string[]): number {
  if (command !== "apply" && command !== "show") return -1
  return args.findIndex(
    (arg, index) =>
      !arg.startsWith("-") && !VALUE_FLAGS.has(args[index - 1] ?? "")
  )
}

/** True when `apply` would apply a saved plan rather than plan again. */
export function appliesSavedPlan(command: string, args: string[]): boolean {
  return command === "apply" && planArgument(command, args) !== -1
}

/**
 * Terraform arguments for one command against the instance. `init`
 * configures the local backend at the instance's state (`-reconfigure`: after
 * the instance directory moves, Terraform neither copies state from nor reuses
 * the path it recorded). Commands that read variables get the instance's
 * tfvars, except an apply of a saved plan. A relative plan path (`-out=NAME`,
 * `apply NAME`, `show NAME`) is in the instance's Terraform directory.
 */
export function terraformArguments(
  command: string,
  args: string[],
  files: InstanceTerraform
): string[] {
  if (command === "init")
    return [
      "-reconfigure",
      `-backend-config=path=${files.state}`,
      `-backend-config=workspace_dir=${files.workspaces}`,
      ...args,
    ]
  const local = (path: string) => resolve(files.directory, path)
  const plan = planArgument(command, args)
  const resolved = args.map((arg, index) => {
    if (arg.startsWith("-out=")) return `-out=${local(arg.slice(5))}`
    if (args[index - 1] === "-out" || index === plan) return local(arg)
    return arg
  })
  return VARIABLE_COMMANDS.has(command) && !appliesSavedPlan(command, args)
    ? [`-var-file=${files.vars}`, ...resolved]
    : resolved
}

/** The drivers' own options, wherever they appear; the rest go to Terraform. */
const DRIVER_OPTIONS = ["--root", "--instance-dir", "--source"]

/** Arguments a driver forwards to Terraform: everything but its own options. */
export function forwardedArgs(args: string[]): string[] {
  return args.filter(
    (arg, index) =>
      !DRIVER_OPTIONS.includes(arg) &&
      !DRIVER_OPTIONS.includes(args[index - 1] ?? "") &&
      !DRIVER_OPTIONS.some((option) => arg.startsWith(`${option}=`))
  )
}

/** The saved plan a resolved `plan` command writes, if any. */
export function planOutput(args: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith("-out=")) return arg.slice(5)
    if (arg === "-out") return args[index + 1]
  }
  return undefined
}

const backendRecordSchema = z.looseObject({
  backend: z
    .looseObject({
      type: z.string(),
      config: z.looseObject({ path: z.string().nullish() }).nullish(),
    })
    .nullish(),
})

/**
 * Refuses a command until `init` has pointed the instance's working data at
 * its own state. A working directory initialized for another path (a moved
 * instance directory) would otherwise read that path, find no state and plan
 * to create everything again.
 */
export function assertInitialized(
  files: InstanceTerraform,
  init: string
): void {
  if (!initializedForInstance(files))
    throw new InstanceError(
      `${files.directory} is not initialized for its own state yet. Run:\n  ${init}`
    )
}

/** True when the working data's backend record is the local backend at the instance's state. */
function initializedForInstance(files: InstanceTerraform): boolean {
  try {
    const { backend } = backendRecordSchema.parse(
      JSON.parse(readFileSync(join(files.data, "terraform.tfstate"), "utf8"))
    )
    return backend?.type === "local" && backend.config?.path === files.state
  } catch {
    return false
  }
}

/**
 * Refuses a root that does not declare `backend "local" {}`: Terraform
 * ignores `-backend-config` without one and would keep the state in the root.
 */
export function assertLocalBackend(root: string): void {
  const declared =
    existsSync(root) &&
    readdirSync(root).some(
      (name) =>
        name.endsWith(".tf") &&
        /^\s*backend\s+"local"/mu.test(readFileSync(join(root, name), "utf8"))
    )
  if (!declared)
    throw new InstanceError(
      `${root} does not declare backend "local" {}, so Terraform would keep its state there. Use a release whose roots keep state in the instance directory.`
    )
}

/** Writes a private file atomically through a temporary file beside it. */
export function writePrivate(path: string, text: string): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const fd = openSync(temporary, "wx", 0o600)
  try {
    try {
      writeFileSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** dotenv's own entry grammar, so a quoted multi-line value is one entry. */
const dotenvEntry =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gmu

/** One dotenv line that reads back as exactly `value`. */
function envLine(key: string, value: string): string {
  for (const quote of ["", "'", '"', "`"]) {
    const line = `${key}=${quote}${value}${quote}\n`
    const parsed = parse(line)
    if (Object.keys(parsed).length === 1 && parsed[key] === value) return line
  }
  throw new InstanceError(
    `${key} cannot be written to a dotenv file without changing its value.`
  )
}

/**
 * Sets `entries` in a private dotenv file and keeps every other line as
 * written. The result is parsed before it replaces the file: every other
 * setting must read back unchanged and every entry as given, or nothing is
 * written.
 */
export function upsertSettings(
  path: string,
  entries: Record<string, string>
): void {
  const text = readFileSync(path, "utf8")
  const before = parse(text)
  const changed = Object.entries(entries).filter(
    ([key, value]) => before[key] !== value
  )
  if (!changed.length) return
  const keys = new Set(changed.map(([key]) => key))
  let kept = ""
  let from = 0
  for (const entry of text.matchAll(dotenvEntry)) {
    if (!keys.has(entry[1])) continue
    kept += text.slice(from, entry.index)
    from = entry.index + entry[0].length
    if (text[from] === "\n") from += 1
  }
  kept += text.slice(from)
  if (kept && !kept.endsWith("\n")) kept += "\n"
  const next = `${kept}${changed.map(([key, value]) => envLine(key, value)).join("")}`
  const after = parse(next)
  if (
    Object.entries(before).some(
      ([key, value]) => !keys.has(key) && after[key] !== value
    ) ||
    changed.some(([key, value]) => after[key] !== value)
  )
    throw new InstanceError(
      `${path} could not be updated without changing other settings. It was left as it was.`
    )
  writePrivate(path, next)
}
