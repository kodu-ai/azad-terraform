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
 *   bun scripts/gcp.ts deploy --source APP_CHECKOUT --instance-dir DIR
 *   bun scripts/gcp.ts refresh | destroy ... --source APP_CHECKOUT --instance-dir DIR
 *   bun scripts/gcp.ts phase | output | show | state ... --instance-dir DIR
 *
 * `setup` reads the hostname's Cloudflare zone and Clerk's production CNAMEs
 * with the private credential file and writes the instance's
 * terraform.tfvars.json once. The credentials stay in that file: Terraform
 * gets CLOUDFLARE_API_TOKEN from it, and the deploy (`deploy`, which runs
 * the app's celld-install.ts with module.app's handoff) reads it directly,
 * so none of them enters Terraform state (the secrets Terraform generates,
 * such as the database password, do). Google access is Application Default
 * Credentials. Terraform's state lives in the installation's GCS bucket
 * (see ./state.ts); variables, saved plans and the deploy's cache of the
 * keys live in `DIR/terraform/gcp-celld/` (see ./instance.ts).
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
import { clerkDns, HELP, hostZones, SetupError } from "./cloudflare"
import {
  appliesSavedPlan,
  assertBackend,
  assertInitialized,
  assertInstancePaths,
  changingPhase,
  forwardedArgs,
  instanceTerraform,
  InstanceError,
  planOutput,
  REPOSITORY,
  rootNamed,
  terraformArguments,
  writePrivate,
  type InstanceTerraform,
} from "./instance"
import { readEnvFile, type Fetcher } from "./lib"
import {
  assertOwnCurrent,
  assertStateHere,
  bucketConfiguration,
  initOwnBackend,
  ownBackend,
  ownBackendFile,
  beginOwnWrite,
  finishOwnWrite,
} from "./own-backend"
import {
  assertMoved,
  configureBackend,
  gcpStore,
  installStore,
  localState,
  moveLocalState,
  readBackendRecord,
  withOperation,
  type TerraformRun,
} from "./state"
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
  name: z.string(),
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

/** Resource addresses in the installation's state; empty before the first apply. */
function stateAddresses(terraform: TerraformRun): string[] {
  const result = terraform(["state", "list"], { capture: true })
  if (result.status !== 0) return []
  return result.stdout.split("\n").filter(Boolean)
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
  "force-unlock",
]
/**
 * Commands that deploy or validate the app, or hold the installation's
 * operation record (through the app's install-store.ts): they need its
 * source checkout.
 */
const SOURCE_COMMANDS = new Set([
  "setup",
  "refresh",
  "plan",
  "apply",
  "destroy",
  "deploy",
  "backup-keys",
])
const USAGE = `Usage: gcp.ts setup --credentials FILE --project-id ID --region REGION --web-host HOST --account-id ID [--evaluation] [--disk-backups hourly|daily|weekly|off] [--agent-machine TYPE|none] --source APP_CHECKOUT --instance-dir DIR [--root gcp-celld]
       gcp.ts refresh|plan|apply|destroy|deploy --source APP_CHECKOUT --instance-dir DIR [--root gcp-celld] [--take-over OPERATION] [terraform arguments]
       gcp.ts backup-keys --out NEW_DIR --source APP_CHECKOUT --instance-dir DIR [--root gcp-celld]
       gcp.ts phase|init|output|show|state|force-unlock --instance-dir DIR [--root gcp-celld] [terraform arguments]
--source may instead come from AZAD_SOURCE. state mv|rm|push also needs it, and so does init while it moves a 0.0.x local state.`

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (HELP.has(command)) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
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
      "take-over": { type: "string" },
      out: { type: "string" },
    },
    strict: ["setup", "refresh", "phase", "deploy", "backup-keys"].includes(
      command
    ),
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
      "take-over": z.string().optional(),
      out: z.string().optional(),
    })
    .loose()
    .parse(parsed.values)
  if (
    ![
      "setup",
      "refresh",
      "phase",
      "deploy",
      "backup-keys",
      ...TERRAFORM_COMMANDS,
    ].includes(command)
  )
    throw new SetupError(`${USAGE}\nNo operation runs by default.`)
  if (!options["instance-dir"])
    throw new SetupError(
      `--instance-dir names the directory that holds this installation's settings, Terraform state and variables.\n${USAGE}`
    )
  const files = instanceTerraform(
    options["instance-dir"],
    rootNamed(options.root, ROOT_NAMES)
  )
  assertBackend(files)
  // The source is checked before anything is read from the network or written.
  // init needs it only to move a local state or point the bucket at the
  // installation's own backend, under the operation record.
  const source =
    SOURCE_COMMANDS.has(command) ||
    changingPhase(command, forwardedArgs(args)) !== undefined ||
    (command === "init" &&
      (localState(files) !== undefined || existsSync(ownBackendFile(files))))
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
  const store = gcpStore(vars.name, vars.project_id)
  const initCommand = commandLine("init")
  const forwardedRaw = forwardedArgs(args)
  // Set for a plan before the installation's first deploy (see the root's
  // first_deploy_pending).
  let firstDeployPending = false
  // With a backend_override.tf, Terraform runs in the installation's copy of
  // the root with that backend.
  const own = ownBackend(files)
  const runner =
    (where: { root: string; data: string }): TerraformRun =>
    (terraformArgs, run = {}) => {
      const result = Bun.spawnSync(
        ["terraform", `-chdir=${where.root}`, ...terraformArgs],
        {
          env: {
            ...process.env,
            TF_DATA_DIR: where.data,
            CLOUDFLARE_API_TOKEN: token,
            TF_VAR_first_deploy_pending: String(firstDeployPending),
            // The updater's grants reach only this bucket's install/ objects
            // and secrets (modules/gcp/updater).
            TF_VAR_install_bucket: store.bucket,
          },
          stdin: "inherit",
          stdout: run.capture ? "pipe" : "inherit",
          stderr: "inherit",
        }
      )
      return {
        // Terraform stopped by a signal has no exit code; that is a failure.
        status: result.exitCode ?? 1,
        stdout: run.capture ? (result.stdout?.toString() ?? "") : "",
      }
    }
  const terraform = runner(own ?? { root: files.root, data: files.data })
  const runs = own && {
    bucket: runner(bucketConfiguration(files)),
    own: terraform,
  }
  const app =
    source &&
    installStore(source, {
      store,
      kind: "celld",
      env_file: vars.deployment.env_file,
      state_directory: vars.deployment.state_directory,
    })
  if (command === "init") {
    mkdirSync(files.directory, { recursive: true, mode: 0o700 })
    await configureBackend(files, store, { token, location: vars.region })
    if (own && runs) {
      if (!app) throw new SetupError(USAGE)
      process.exitCode = initOwnBackend({
        files,
        own,
        runs,
        forwarded: forwardedRaw,
        store: app,
        takeOver: options["take-over"],
      })
      return
    }
    let status = terraform([
      "init",
      ...terraformArguments("init", forwardedRaw, files),
    ]).status
    if (status === 0 && app && localState(files)) {
      let kept: string | undefined
      status = withOperation(
        app,
        "terraform-state-move",
        { takeOver: options["take-over"] },
        () => {
          kept = moveLocalState(files, terraform)
          return 0
        }
      )
      if (kept)
        process.stdout.write(
          `Moved this installation's Terraform state into the GCS bucket ${store.bucket}; the local copy is kept as ${kept}.\n`
        )
    }
    if (status === 0) assertStateHere(terraform, files, initCommand)
    process.exitCode = status
    return
  }
  readBackendRecord(files, initCommand)
  /**
   * Where the state lives. With an own backend the bucket must point at
   * exactly that backend; without one it must not hold the pointer. Checked
   * before a command, and again inside the operation record before one that
   * changes anything: another machine may have moved the state meanwhile.
   */
  const checkState = () => {
    if (command === "force-unlock" || command === "backup-keys") return
    if (own && runs)
      assertOwnCurrent(files, own, runs, initCommand, options["take-over"])
    // state push stays possible: it is how a state comes back to the bucket.
    else if (!(command === "state" && forwardedRaw[0] === "push"))
      assertStateHere(terraform, files, initCommand)
  }
  if (!own) assertInitialized(files, store.bucket, initCommand)
  // force-unlock stays possible: a move that crashed may hold Terraform's lock.
  if (command !== "force-unlock") assertMoved(files, initCommand)
  checkState()
  /** The full installer handoff: Terraform's output, the revision and where state lives. */
  const handoff = (lease: string) => {
    const deploy = deployOutput(terraform)
    if (!deploy)
      throw new SetupError(
        "This installation has no deployment: its variables set none."
      )
    const held = z
      .object({ id: z.string(), version: z.string() })
      .parse(JSON.parse(lease))
    return {
      ...deploy,
      // This machine's files: the output names those of the last apply.
      env_file: vars.deployment.env_file,
      state_directory: vars.deployment.state_directory,
      revision: vars.deployment.revision,
      install_store: store,
      operation_id: held.id,
      operation_version: held.version,
    }
  }
  if (command === "backup-keys") {
    if (!options.out || !app) throw new SetupError(USAGE)
    process.stdout.write(
      `Wrote secrets.json and release-key.pem to ${app.backup(options.out)}. Keep it offline: these keys decrypt the installation's data.\n`
    )
    return
  }
  if (command === "deploy") {
    if (!app || !source) throw new SetupError(USAGE)
    process.exitCode = withOperation(
      app,
      "deploy",
      { takeOver: options["take-over"], revision: vars.deployment.revision },
      (lease) => {
        checkState()
        const input = handoff(lease)
        app.publish(lease, JSON.stringify(input), REPOSITORY)
        // The deploy's progress also goes to <state_directory>/install.log.
        return Bun.spawnSync(
          [
            "/bin/bash",
            "-o",
            "pipefail",
            "-c",
            'umask 077 && mkdir -p "$AZAD_CELLD_STATE" && "$BUN" --no-env-file scripts/self-host/celld-install.ts 2>&1 | tee -a "$AZAD_CELLD_STATE/install.log"',
          ],
          {
            cwd: source.path,
            env: {
              ...process.env,
              BUN: process.execPath,
              AZAD_CELLD_STATE: vars.deployment.state_directory,
              AZAD_CELLD_INSTALL: JSON.stringify(input),
            },
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }
        ).exitCode
      }
    )
    return
  }
  const addresses = stateAddresses(terraform)
  if (command === "phase") {
    // Read by the installer: which plan comes next.
    process.stdout.write(`${clusterExists(addresses) ? "full" : "cluster"}\n`)
    return
  }
  const forwarded = terraformArguments(command, forwardedRaw, files)
  const plan = command === "plan" ? planOutput(forwarded) : undefined
  // A failed plan must never leave an older plan where the apply looks.
  if (plan) rmSync(plan, { force: true })
  const run = (work: () => number) => {
    const phase = changingPhase(command, forwardedRaw)
    if (!phase || !app) return work()
    return withOperation(
      app,
      phase,
      { takeOver: options["take-over"] },
      (lease) => {
        checkState()
        if (own && runs)
          beginOwnWrite(
            files,
            own,
            runs,
            z.object({ id: z.string() }).parse(JSON.parse(lease)).id
          )
        const status = work()
        // Recorded even after a failure: a failed apply keeps what it created.
        if (own && runs) finishOwnWrite(files, runs)
        // The deployment object tells release updates what this infrastructure
        // provides; it is written after every apply that completes it.
        if (status === 0 && command === "apply" && deployOutput(terraform))
          app.publish(lease, JSON.stringify(handoff(lease)), REPOSITORY)
        return status
      }
    )
  }
  if (command === "destroy" && addresses.length && !clusterExists(addresses)) {
    // A destroy that stopped after the cluster went cannot plan the Kubernetes
    // resources any more; it finishes what is left in state.
    process.stdout.write(
      "The cluster is already gone; destroying the remaining resources.\n"
    )
    process.exitCode = run(
      () =>
        terraform([
          command,
          ...addresses.map((address) => `-target=${address}`),
          ...forwarded,
        ]).status
    )
    return
  }
  const plans =
    command === "plan" ||
    (command === "apply" && !appliesSavedPlan(command, forwarded))
  // Until a deploy has recorded its receipt, the fleets may serve nothing, so
  // DNS cannot wait for the load balancer's check. (An installation from
  // azad 0.0.x gets its receipt into the store on its first apply here.)
  // A direct apply before the cluster exists runs the full apply right after
  // the cluster's, so the flag is set for both.
  if (plans && app) firstDeployPending = !app.deployed()
  process.exitCode = run(() => {
    if (plans && !clusterExists(addresses)) {
      // Everything else plans against the cluster's API, so a first install
      // creates the cluster on its own; a plan before that covers only it.
      // Clerk's DNS records come along so Clerk can verify them meanwhile.
      process.stdout.write(
        command === "plan"
          ? "The cluster does not exist yet: this plan (1 of 2) covers only the cluster and Clerk's DNS records. The full plan (2 of 2) follows once they are created.\n"
          : "Creating the cluster and Clerk's DNS records first; everything else is planned against the cluster.\n"
      )
      const status = terraform([
        command,
        "-target=module.gke",
        "-target=module.clerk_dns",
        ...forwarded,
      ]).status
      if (status !== 0 || command === "plan") return status
    }
    return terraform([command, ...forwarded]).status
  })
}

/** module.app's handoff once the full configuration is applied; undefined before (or without a deployment). */
function deployOutput(terraform: TerraformRun) {
  const result = terraform(["output", "-json", "deploy"], { capture: true })
  if (result.status !== 0 || !result.stdout.trim()) return undefined
  return (
    z
      .record(z.string(), z.json())
      .nullable()
      .parse(JSON.parse(result.stdout)) ?? undefined
  )
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
