/**
 * Google Cloud installation (celld on GKE Autopilot) with the `gcp-celld`
 * root, deployed from an Azad app source checkout (`--source`, see
 * ./source.ts):
 *
 *   bun scripts/gcp.ts setup --credentials DIR/.env \
 *     --project-id ID --region REGION --web-host board.example.com \
 *     --account-id CLOUDFLARE_ACCOUNT [--evaluation] \
 *     --source APP_CHECKOUT --instance-dir DIR
 *   bun scripts/gcp.ts init --instance-dir DIR
 *   bun scripts/gcp.ts plan -out=NAME.tfplan --source APP_CHECKOUT --instance-dir DIR
 *   bun scripts/gcp.ts apply NAME.tfplan --source APP_CHECKOUT --instance-dir DIR
 *   bun scripts/gcp.ts refresh | destroy ... --source APP_CHECKOUT --instance-dir DIR
 *   bun scripts/gcp.ts phase | output | show | state ... --instance-dir DIR
 *
 * `setup` reads the hostname's Cloudflare zone and Clerk's production CNAMEs
 * with the private credential file and writes the instance's
 * terraform.tfvars.json once. The credentials stay in that file: Terraform
 * gets CLOUDFLARE_API_TOKEN from it, and the deploy step (module.app) reads
 * it directly, so none of them enters Terraform state (the secrets Terraform
 * generates, such as the database password, do). Google access is
 * Application Default Credentials. State, variables, saved plans and the
 * deploy step's keys live in `DIR/terraform/gcp-celld/` (see ./instance.ts).
 *
 * A first install plans twice: everything but the cluster and Clerk's DNS
 * records is planned against the cluster's API, so the first plan (`phase`
 * prints `cluster`) covers only those, and the full plan (`full`) follows
 * once they exist.
 */
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { clerkDns, hostZones, SetupError } from "./cloudflare"
import {
  appliesSavedPlan,
  assertInitialized,
  assertInstancePaths,
  assertLocalBackend,
  forwardedArgs,
  instanceTerraform,
  InstanceError,
  planOutput,
  REPOSITORY,
  rootNamed,
  terraformArguments,
  terraformEnvironment,
  writePrivate,
  type InstanceTerraform,
} from "./instance"
import { readEnvFile, type Fetcher } from "./lib"
import {
  requireSource,
  SettingsRefused,
  sourceSettings,
  SourceError,
  type AppSettings,
  type Source,
} from "./source"

const ROOT_NAMES = ["gcp-celld"] as const
/** The deploy step's state directory, in the instance's Terraform directory. */
const STATE_DIRECTORY = "celld-install"
const DRIVER = `bun --no-env-file ${join(REPOSITORY, "scripts/gcp.ts")}`

/**
 * Machines setup offers for the installation's agent machine
 * (modules/gcp/agent-machine), all available in Google Cloud's regions with
 * N2 and E2. The label is what project setup shows.
 */
const AGENT_MACHINE_TYPES = [
  "e2-standard-4",
  "n2-highcpu-8",
  "n2-custom-8-16384",
  "n2-standard-8",
  "n2-highcpu-16",
  "n2-standard-16",
  "n2-standard-32",
] as const
export const AGENT_MACHINES: Record<
  (typeof AGENT_MACHINE_TYPES)[number],
  string
> = {
  "e2-standard-4": "4 vCPU · 16 GB",
  "n2-highcpu-8": "8 vCPU · 8 GB",
  "n2-custom-8-16384": "8 vCPU · 16 GB",
  "n2-standard-8": "8 vCPU · 32 GB",
  "n2-highcpu-16": "16 vCPU · 16 GB",
  "n2-standard-16": "16 vCPU · 64 GB",
  "n2-standard-32": "32 vCPU · 128 GB",
}
const agentMachineSchema = z.enum([...AGENT_MACHINE_TYPES, "none"])

const inputSchema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  region: z.string().regex(/^[a-z]+-[a-z]+[0-9]+$/u),
  webHost: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/u),
  accountId: z.string().regex(/^[a-f0-9]{32}$/u),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  credentialsPath: z.string().min(1),
  evaluation: z.boolean(),
  /** Scheduled Backup for GKE snapshots of the app's disks (Forgejo's repositories). */
  diskBackups: z.enum(["hourly", "daily", "weekly", "off"]).default("daily"),
  /** Compute Engine type of the agent machine, or none. */
  agentMachine: agentMachineSchema.default("none"),
})

const varsSchema = z.looseObject({
  project_id: z.string(),
  region: z.string(),
  web_host: z.string(),
  deployment: z.looseObject({
    revision: z.string(),
    env_file: z.string(),
    state_directory: z.string(),
  }),
})

/** The variables setup writes; the rest keep the root's defaults. */
type GcpVariables = {
  project_id: string
  region: string
  name: string
  web_host: string
  cloudflare_zone_id: string
  deployment: { revision: string; env_file: string; state_directory?: string }
  clerk_dns?: { zone_id: string; records: Record<string, string> }
  spot?: boolean
  deletion_protection?: boolean
  database?: { tier: string; backups: boolean }
  /** The Clerk application the setup created; evaluation installs delete it on destroy. */
  clerk_application?: { id: string; delete_on_destroy: boolean }
  disk_backups: { schedule: "hourly" | "daily" | "weekly" | "off" }
  agent_machine?: { machine_type: string; label: string }
}

/**
 * Google resource prefix for one hostname: short enough for every derived
 * name (the cluster is `<name>-celld`, at most 40 characters) and distinct per
 * hostname so several installations can share a project.
 */
export function gcpName(webHost: string): string {
  const label = webHost
    .split(".")[0]
    .replaceAll(/[^a-z0-9-]/gu, "-")
    .slice(0, 14)
    .replace(/-+$/u, "")
  const hash = createHash("sha256").update(webHost).digest("hex").slice(0, 4)
  return `azad-${label}-${hash}`
}

/**
 * The root's terraform.tfvars.json for one installation. Reads Cloudflare with
 * the deployment token (Zone Read on the hostname's zone) and Clerk with the
 * instance secret key; writes nothing.
 *
 * @throws SetupError when the credential file is incomplete, the hostname is
 * not in a zone of the account, or Clerk's DNS conflicts with existing records.
 */
export async function prepareGcp(
  raw: z.input<typeof inputSchema>,
  app: AppSettings,
  fetcher: Fetcher = fetch
) {
  const input = inputSchema.parse(raw)
  const env = readEnvFile(input.credentialsPath)
  const token = env.CLOUDFLARE_API_TOKEN?.trim()
  if (!token)
    throw new SetupError("The credential file needs CLOUDFLARE_API_TOKEN.")
  try {
    app.validate("celld", env)
  } catch (error) {
    if (error instanceof SettingsRefused) throw new SetupError(error.message)
    throw error
  }
  const apiHost = `api.${input.webHost}`
  const zones = await hostZones(fetcher, token, input.accountId, [
    input.webHost,
    apiHost,
  ])
  if (zones[input.webHost] !== zones[apiHost])
    throw new SetupError(
      `${input.webHost} and ${apiHost} must be in the same Cloudflare zone.`
    )
  const clerk = await clerkDns(
    fetcher,
    env.CLERK_SECRET_KEY?.trim() ?? "",
    token,
    input.accountId
  )
  const tfvars: GcpVariables = {
    project_id: input.projectId,
    region: input.region,
    name: gcpName(input.webHost),
    web_host: input.webHost,
    cloudflare_zone_id: zones[input.webHost],
    deployment: {
      revision: input.revision,
      env_file: resolve(input.credentialsPath),
    },
    clerk_dns:
      clerk && "records" in clerk && Object.keys(clerk.records).length
        ? { zone_id: clerk.zone_id, records: clerk.records }
        : undefined,
    disk_backups: { schedule: input.diskBackups },
  }
  if (input.agentMachine !== "none")
    tfvars.agent_machine = {
      machine_type: input.agentMachine,
      label: AGENT_MACHINES[input.agentMachine],
    }
  const clerkApplication = env.AZAD_CLI_CLERK_APP_ID?.trim()
  if (clerkApplication && /^app_[A-Za-z0-9]+$/u.test(clerkApplication))
    tfvars.clerk_application = {
      id: clerkApplication,
      delete_on_destroy: input.evaluation,
    }
  if (input.evaluation) {
    // Spot nodes, the smallest database without backups, and a destroy that
    // removes everything including the stored data and the Clerk application.
    tfvars.spot = true
    tfvars.deletion_protection = false
    tfvars.database = { tier: "db-f1-micro", backups: false }
  }
  return { clerkDns: clerk, tfvars }
}

/** The instance's variables; their files must be absolute paths outside this repository. */
function readVars(files: InstanceTerraform) {
  if (!existsSync(files.vars))
    throw new SetupError(`Run setup first: ${files.vars} does not exist.`)
  const vars = varsSchema.parse(JSON.parse(readFileSync(files.vars, "utf8")))
  assertInstancePaths(vars.deployment, files.vars)
  return vars
}

/**
 * Runs Terraform in the root against the instance's state and working data,
 * with the deployment token from the credential file and, when the command
 * has one, the app source checkout (`source_dir`).
 */
function terraform(
  files: InstanceTerraform,
  args: string[],
  token: string,
  source: Source | undefined
): number {
  const result = Bun.spawnSync(["terraform", `-chdir=${files.root}`, ...args], {
    env: {
      ...process.env,
      ...terraformEnvironment(files),
      CLOUDFLARE_API_TOKEN: token,
      ...(source
        ? { TF_VAR_source_dir: source.path, AZAD_SOURCE: source.path }
        : {}),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return result.exitCode
}

/** Resource addresses in the instance's state; empty before the first apply. */
function stateAddresses(files: InstanceTerraform): string[] {
  const result = Bun.spawnSync(
    ["terraform", `-chdir=${files.root}`, "state", "list"],
    {
      env: { ...process.env, ...terraformEnvironment(files) },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  if (result.exitCode !== 0) return []
  return result.stdout.toString().split("\n").filter(Boolean)
}

/** True once the cluster is in state; the Kubernetes provider is configured from it. */
function clusterExists(addresses: string[]): boolean {
  return addresses.some((address) =>
    address.startsWith("module.gke.google_container_cluster.")
  )
}

const TERRAFORM_COMMANDS = [
  "init",
  "plan",
  "apply",
  "destroy",
  "output",
  "show",
  "state",
]
/** Commands that deploy, uninstall or validate the app: they need its source checkout. */
const SOURCE_COMMANDS = new Set([
  "setup",
  "refresh",
  "plan",
  "apply",
  "destroy",
])
const USAGE = `Usage: gcp.ts setup --credentials FILE --project-id ID --region REGION --web-host HOST --account-id ID [--evaluation] [--disk-backups hourly|daily|weekly|off] [--agent-machine TYPE|none] --source APP_CHECKOUT --instance-dir DIR [--root gcp-celld]
       gcp.ts refresh|plan|apply|destroy --source APP_CHECKOUT --instance-dir DIR [--root gcp-celld] [terraform arguments]
       gcp.ts phase|init|output|show|state --instance-dir DIR [--root gcp-celld] [terraform arguments]
--source may instead come from AZAD_SOURCE.`

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const parsed = parseArgs({
    args,
    options: {
      credentials: { type: "string" },
      "project-id": { type: "string" },
      region: { type: "string" },
      "web-host": { type: "string" },
      "account-id": { type: "string" },
      evaluation: { type: "boolean", default: false },
      "disk-backups": { type: "string", default: "daily" },
      "agent-machine": { type: "string", default: "none" },
      root: { type: "string", default: ROOT_NAMES[0] },
      source: { type: "string" },
      "instance-dir": { type: "string" },
    },
    strict: ["setup", "refresh", "phase"].includes(command),
    allowPositionals: true,
  })
  const options = z
    .object({
      credentials: z.string().optional(),
      "project-id": z.string().optional(),
      region: z.string().optional(),
      "web-host": z.string().optional(),
      "account-id": z.string().optional(),
      evaluation: z.boolean().default(false),
      "disk-backups": z
        .enum(["hourly", "daily", "weekly", "off"])
        .default("daily"),
      "agent-machine": agentMachineSchema.default("none"),
      root: z.string().default(ROOT_NAMES[0]),
      source: z.string().optional(),
      "instance-dir": z.string().optional(),
    })
    .loose()
    .parse(parsed.values)
  if (!["setup", "refresh", "phase", ...TERRAFORM_COMMANDS].includes(command))
    throw new SetupError(`${USAGE}\nNo operation runs by default.`)
  if (!options["instance-dir"])
    throw new SetupError(
      `--instance-dir names the directory that holds this installation's settings, Terraform state and variables.\n${USAGE}`
    )
  const files = instanceTerraform(
    options["instance-dir"],
    rootNamed(options.root, ROOT_NAMES)
  )
  assertLocalBackend(files.root)
  // The source is checked before anything is read from the network or written.
  const source = SOURCE_COMMANDS.has(command)
    ? requireSource(options.source)
    : undefined
  const commandLine = (name: string) =>
    `${DRIVER} ${name} --instance-dir ${files.instance}`
  if (command === "setup") {
    if (
      !options.credentials ||
      !options["project-id"] ||
      !options.region ||
      !options["web-host"] ||
      !options["account-id"] ||
      !source
    )
      throw new SetupError(USAGE)
    if (existsSync(files.vars))
      throw new SetupError(
        `${files.vars} already exists. Edit it in place, or use refresh after changing the source checkout.`
      )
    const result = await prepareGcp(
      {
        projectId: options["project-id"],
        region: options.region,
        webHost: options["web-host"],
        accountId: options["account-id"],
        revision: source.revision,
        credentialsPath: options.credentials,
        evaluation: options.evaluation,
        diskBackups: options["disk-backups"],
        agentMachine: options["agent-machine"],
      },
      sourceSettings(source)
    )
    const tfvars: GcpVariables = {
      ...result.tfvars,
      deployment: {
        ...result.tfvars.deployment,
        state_directory: join(files.directory, STATE_DIRECTORY),
      },
    }
    assertInstancePaths(
      {
        env_file: tfvars.deployment.env_file,
        state_directory: join(files.directory, STATE_DIRECTORY),
      },
      files.vars
    )
    mkdirSync(files.directory, { recursive: true, mode: 0o700 })
    writeFileSync(files.vars, `${JSON.stringify(tfvars, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    })
    const lines = [`Created ${files.vars}.`]
    if (result.clerkDns && "manual" in result.clerkDns)
      lines.push(
        "Add Clerk's DNS records (CNAME) at the domain's DNS provider:",
        ...Object.entries(result.clerkDns.manual).map(
          ([host, value]) => `  ${host} → ${value}`
        )
      )
    process.stdout.write(`${lines.join("\n")}\n`)
    return
  }
  if (command === "refresh" && source) {
    const vars = readVars(files)
    vars.deployment.revision = source.revision
    writePrivate(files.vars, `${JSON.stringify(vars, null, 2)}\n`)
    process.stdout.write(
      `Updated deployment.revision to ${source.revision} (${source.path}).\n`
    )
    return
  }
  const vars = readVars(files)
  const token = readEnvFile(vars.deployment.env_file).CLOUDFLARE_API_TOKEN
  if (!token?.trim())
    throw new SetupError("The credential file needs CLOUDFLARE_API_TOKEN.")
  if (command === "init") {
    mkdirSync(files.directory, { recursive: true, mode: 0o700 })
    process.exitCode = terraform(
      files,
      ["init", ...terraformArguments("init", forwardedArgs(args), files)],
      token,
      undefined
    )
    return
  }
  assertInitialized(files, commandLine("init"))
  const addresses = stateAddresses(files)
  if (command === "phase") {
    // Read by the installer: which plan comes next.
    process.stdout.write(`${clusterExists(addresses) ? "full" : "cluster"}\n`)
    return
  }
  const forwarded = terraformArguments(command, forwardedArgs(args), files)
  const plan = command === "plan" ? planOutput(forwarded) : undefined
  // A failed plan must never leave an older plan where the apply looks.
  if (plan) rmSync(plan, { force: true })
  if (command === "destroy" && addresses.length && !clusterExists(addresses)) {
    // A destroy that stopped after the cluster went cannot plan the Kubernetes
    // resources any more; it finishes what is left in state.
    process.stdout.write(
      "The cluster is already gone; destroying the remaining resources.\n"
    )
    process.exitCode = terraform(
      files,
      [
        command,
        ...addresses.map((address) => `-target=${address}`),
        ...forwarded,
      ],
      token,
      source
    )
    return
  }
  if (
    (command === "plan" ||
      (command === "apply" && !appliesSavedPlan(command, forwarded))) &&
    !clusterExists(addresses)
  ) {
    // Everything else plans against the cluster's API, so a first install
    // creates the cluster on its own; a plan before that covers only it.
    // Clerk's DNS records come along so Clerk can verify them meanwhile.
    process.stdout.write(
      command === "plan"
        ? "The cluster does not exist yet: this plan (1 of 2) covers only the cluster and Clerk's DNS records. The full plan (2 of 2) follows once they are created.\n"
        : "Creating the cluster and Clerk's DNS records first; everything else is planned against the cluster.\n"
    )
    const status = terraform(
      files,
      [command, "-target=module.gke", "-target=module.clerk_dns", ...forwarded],
      token,
      source
    )
    if (status !== 0 || command === "plan") {
      process.exitCode = status
      return
    }
  }
  process.exitCode = terraform(files, [command, ...forwarded], token, source)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof SetupError || error instanceof InstanceError || error instanceof SourceError ? error.message : "Google Cloud setup failed. Check the input files and credential formats; no credential values are logged."}\n`
    )
    process.exitCode = 1
  }
}
