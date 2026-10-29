import { createHash } from "node:crypto"
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { parse } from "dotenv"
import { z } from "zod"
import { REPOSITORY } from "./instance"
import { isolatedProcessEnv, writePrivateJson } from "./lib"
import { sourceOption } from "./source"

/**
 * Creates an installation's scoped Cloudflare API tokens (roots/bootstrap)
 * from one administrator token that may create tokens:
 *
 *   bun scripts/bootstrap.ts plan|apply --config FILE \
 *     --bootstrap-file PRIVATE_ENV --state-dir PRIVATE_DIRECTORY \
 *     [--source APP_CHECKOUT]
 *
 * The configuration's `revision` must be the HEAD of the Azad app source
 * checkout the installation deploys: `--source`, else AZAD_SOURCE, else the
 * current directory. Nothing of the app runs here.
 */

class BootstrapError extends Error {
  name = "BootstrapError"
}
const id = z.string().regex(/^[a-f0-9]{32}$/u)
const host = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u)
export const bootstrapConfigSchema = z
  .object({
    version: z.literal(1),
    accountId: id,
    webHost: host,
    apiHost: host,
    revision: z.string().regex(/^[a-f0-9]{40}$/u),
    miniApps: z.boolean(),
    verifyDatabaseCertificate: z.boolean(),
    registerDatabaseCertificate: z.boolean().optional(),
    /**
     * Managed project source on Cloudflare Artifacts: an Artifacts token and,
     * on Cloudflare, a Queues token for its push-event subscriptions (Google
     * Cloud has no queue consumer for them). May be added to a completed
     * bootstrap later; it is never taken away.
     */
    managedSource: z.boolean().optional(),
    /** Absent means Cloudflare; "gcp" keeps Cloudflare only for DNS and TLS in front of GKE. */
    target: z.enum(["cloudflare", "gcp"]).optional(),
  })
  .strict()
  .refine(
    (config) =>
      config.target !== "gcp" ||
      (!config.miniApps && !config.verifyDatabaseCertificate),
    "On Google Cloud, Mini Apps and database TLS need no Cloudflare credential."
  )
  .refine(
    (config) =>
      !config.registerDatabaseCertificate || config.verifyDatabaseCertificate,
    "Automatic CA registration requires verified database TLS."
  )
export type BootstrapConfig = z.infer<typeof bootstrapConfigSchema>
const groupSchema = z.object({
  id,
  name: z.string(),
  scopes: z.array(z.string()),
  is_selectable: z.boolean().optional(),
})
type Group = z.infer<typeof groupSchema>
type Policy = {
  effect: string
  permission_groups: { id: string }[]
  resources: string
}
type Token = { name: string; policies: Policy[] }
type Tokens = Record<string, Token>
const valuesSchema = z.record(
  z.string(),
  z.object({ id, value: z.string().min(1) })
)
type Values = z.infer<typeof valuesSchema>
const receiptSchema = z
  .object({
    version: z.literal(1),
    config: bootstrapConfigSchema,
    phase: z.enum(["prepared", "discovery", "ready", "complete"]),
    zoneIds: z.array(id),
  })
  .strict()
type Receipt = z.infer<typeof receiptSchema>
const accountScope = "com.cloudflare.api.account"
const zoneScope = "com.cloudflare.api.account.zone"
const deploymentAccountGroups = [
  "Account Settings Read",
  "Workers Scripts Write",
  "Workers R2 Storage Write",
  "Queues Write",
  "Hyperdrive Write",
  "Pages Write",
]

function permission(groups: Group[], name: string, scope: string) {
  const matches = groups.filter(
    (group) => group.name === name && group.scopes.includes(scope)
  )
  if (matches.length !== 1 || matches[0].is_selectable === false)
    throw new BootstrapError(
      `Cloudflare does not offer the required ${name} permission for this administrator. Check account membership and token-management authority.`
    )
  return { id: matches[0].id }
}
function policy(
  groups: Group[],
  names: string[],
  scope: string,
  resources: Record<string, string | Record<string, string>>
): Policy {
  return {
    effect: "allow",
    permission_groups: names.map((name) => permission(groups, name, scope)),
    resources: JSON.stringify(resources),
  }
}
function prefix(config: BootstrapConfig) {
  const hash = createHash("sha256")
    .update(`${config.accountId}\n${config.webHost}\n${config.apiHost}`)
    .digest("hex")
    .slice(0, 20)
  return `azad-${hash}`
}
/**
 * The deployment token's grants per target. Cloudflare hosts the Workers,
 * storage and database proxy; on Google Cloud, Cloudflare only serves DNS,
 * the Origin CA certificate and the Full (strict) TLS rule in front of GKE.
 */
/** Permission group names granted at account and at zone scope. */
export type DeploymentGrants = { account: string[]; zone: string[] }

export function deploymentGroups(config: BootstrapConfig): DeploymentGrants {
  if (config.target === "gcp")
    return {
      account: [],
      zone: [
        "Zone Read",
        "DNS Write",
        "SSL and Certificates Write",
        "Config Settings Write",
      ],
    }
  return {
    account: [
      ...deploymentAccountGroups,
      ...(config.verifyDatabaseCertificate
        ? [
            config.registerDatabaseCertificate
              ? "Account: SSL and Certificates Write"
              : "Account: SSL and Certificates Read",
          ]
        : []),
    ],
    zone: ["Zone Read", "DNS Write", "Workers Routes Write"],
  }
}

/** Plans only the deployment grants required by selected features, with no management permission in any derived token. */
export function tokenPolicies(
  config: BootstrapConfig,
  groups: Group[],
  zoneIds: string[],
  discovery: boolean
) {
  const account = { [`${accountScope}.${config.accountId}`]: "*" }
  const tokens: Tokens = {}
  if (discovery)
    tokens.discovery = {
      name: `${prefix(config)}-discovery`,
      policies: [
        policy(groups, ["Zone Read"], zoneScope, {
          [`${accountScope}.${config.accountId}`]: { [`${zoneScope}.*`]: "*" },
        }),
      ],
    }
  if (zoneIds.length) {
    const grants = deploymentGroups(config)
    tokens.deployment = {
      name: `${prefix(config)}-deployment`,
      policies: [
        ...(grants.account.length
          ? [policy(groups, grants.account, accountScope, account)]
          : []),
        policy(
          groups,
          grants.zone,
          zoneScope,
          Object.fromEntries(
            zoneIds.map((zone) => [`${zoneScope}.${zone}`, "*"])
          )
        ),
      ],
    }
    if (config.miniApps)
      tokens.miniapps = {
        name: `${prefix(config)}-miniapps`,
        policies: [
          policy(
            groups,
            ["Workers Scripts Write", "D1 Write"],
            accountScope,
            account
          ),
        ],
      }
    if (config.managedSource) {
      tokens["managed-source"] = {
        name: `${prefix(config)}-managed-source`,
        policies: [
          policy(
            groups,
            ["Artifacts Read", "Artifacts Write"],
            accountScope,
            account
          ),
        ],
      }
      if (config.target !== "gcp")
        tokens["managed-events"] = {
          name: `${prefix(config)}-managed-events`,
          policies: [policy(groups, ["Queues Write"], accountScope, account)],
        }
    }
  }
  return tokens
}

/** External process seam. Callers must never print captured Terraform output: state and JSON outputs contain token values. */
export type BootstrapDependencies = {
  fetcher: typeof fetch
  run: (args: string[], env: Record<string, string>) => Promise<string>
}
const dependencies: BootstrapDependencies = {
  fetcher: fetch,
  async run(args, env) {
    const child = Bun.spawn(args, {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0)
      throw new BootstrapError(
        "Token bootstrap command failed. Preserve its private state and retry with the same configuration. Check token-management authority and Terraform connectivity."
      )
    return stdout
  },
}
async function apiPage<T>(
  deps: BootstrapDependencies,
  token: string,
  path: string,
  schema: z.ZodType<T>
) {
  const response = await deps.fetcher(
    `https://api.cloudflare.com/client/v4${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }
  )
  if (!response.ok)
    throw new BootstrapError(
      `Cloudflare token bootstrap lookup failed (HTTP ${response.status}). Use the Create additional tokens template and verify your account membership.`
    )
  return z
    .object({
      success: z.literal(true),
      result: schema,
      result_info: z
        .object({ total_pages: z.number().int().min(0).optional() })
        .optional(),
    })
    .parse(await response.json())
}
async function api<T>(
  deps: BootstrapDependencies,
  token: string,
  path: string,
  schema: z.ZodType<T>
) {
  return (await apiPage(deps, token, path, schema)).result
}
async function listTokens(deps: BootstrapDependencies, token: string) {
  const result: { id: string; name: string; status?: string }[] = []
  for (let page = 1; page <= 40; page++) {
    const response = await apiPage(
      deps,
      token,
      `/user/tokens?page=${page}&per_page=50`,
      z.array(z.object({ id, name: z.string(), status: z.string().optional() }))
    )
    result.push(...response.result)
    if (response.result_info?.total_pages !== undefined) {
      if (page >= response.result_info.total_pages) return result
    } else if (response.result.length === 0) return result
  }
  throw new BootstrapError(
    "The token inventory exceeds the bootstrap lookup limit; no tokens were changed."
  )
}
async function zones(
  deps: BootstrapDependencies,
  token: string,
  config: BootstrapConfig
) {
  const result = new Set<string>()
  for (const hostname of [config.webHost, config.apiHost]) {
    const labels = hostname.split(".")
    let found = false
    for (let offset = 0; offset < labels.length - 1; offset++) {
      const name = labels.slice(offset).join(".")
      const rows = await api(
        deps,
        token,
        `/zones?name=${encodeURIComponent(name)}&account.id=${config.accountId}&per_page=50`,
        z.array(z.object({ id, name: z.string(), account: z.object({ id }) }))
      )
      if (rows.length === 0) continue
      if (
        rows.length !== 1 ||
        rows[0].name !== name ||
        rows[0].account.id !== config.accountId
      )
        throw new BootstrapError(
          "Cloudflare zone lookup returned an ambiguous or different account/hostname. No deployment token was created."
        )
      result.add(rows[0].id)
      found = true
      break
    }
    if (!found)
      throw new BootstrapError(
        "No authoritative zone was found for a selected hostname in this account. Preserve bootstrap state and correct the account/domain selection."
      )
  }
  return [...result].sort()
}
function privateFile(path: string) {
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new BootstrapError(
      "Bootstrap credentials and state must be regular private files (mode 0600)."
    )
  return readFileSync(path, "utf8")
}
function readValues(state: string): Values {
  if (!existsSync(state)) return {}
  const parsed = z
    .object({
      resources: z
        .array(
          z.object({
            type: z.string(),
            name: z.string(),
            instances: z.array(
              z.object({
                index_key: z.enum([
                  "discovery",
                  "deployment",
                  "miniapps",
                  "managed-source",
                  "managed-events",
                ]),
                attributes: z.object({
                  id: z.string(),
                  value: z.string().nullable().optional(),
                }),
              })
            ),
          })
        )
        .optional(),
    })
    .parse(JSON.parse(privateFile(state)))
  const values: Values = {}
  for (const resource of parsed.resources ?? []) {
    if (resource.type !== "cloudflare_api_token" || resource.name !== "scoped")
      throw new BootstrapError(
        "Unexpected resource in bootstrap state. Restore the original state before continuing."
      )
    for (const instance of resource.instances) {
      if (!instance.attributes.value)
        throw new BootstrapError(
          "Bootstrap state lacks a token secret. Restore its original state; importing metadata cannot recover token values."
        )
      values[instance.index_key] = valuesSchema.valueType.parse(
        instance.attributes
      )
    }
  }
  return values
}
async function verifyValues(deps: BootstrapDependencies, values: Values) {
  for (const value of Object.values(values)) {
    try {
      const verified = await api(
        deps,
        value.value,
        "/user/tokens/verify",
        z.object({ id, status: z.literal("active") })
      )
      if (verified.id !== value.id) throw new Error("Mismatched token identity")
    } catch {
      throw new BootstrapError(
        "A scoped token is invalid or rotated, or its verification could not complete. Restore valid credential state or recover the token explicitly; bootstrap will not recreate it automatically."
      )
    }
  }
}
async function reconcile(
  deps: BootstrapDependencies,
  bootstrapToken: string,
  config: BootstrapConfig,
  values: Values
) {
  const remote = (await listTokens(deps, bootstrapToken)).filter((token) =>
    token.name.startsWith(`${prefix(config)}-`)
  )
  for (const row of remote) {
    const key = row.name.slice(prefix(config).length + 1)
    if (
      !values[key] ||
      values[key].id !== row.id ||
      (row.status && row.status !== "active")
    )
      throw new BootstrapError(
        "An installation token exists without matching usable private state. Restore the original bootstrap state; no token will be adopted or replaced automatically."
      )
  }
  for (const [key, value] of Object.entries(values)) {
    if (
      !remote.some(
        (row) => row.name === `${prefix(config)}-${key}` && row.id === value.id
      )
    )
      throw new BootstrapError(
        "A saved installation token is absent from the administrator's token inventory. Check the original administrator or recover the token explicitly; bootstrap will not replace it automatically."
      )
  }
  await verifyValues(deps, values)
}
/** Same installation and source; managed project source may be added, never removed. */
function checkConfig(receipt: Receipt, config: BootstrapConfig) {
  const comparable = (value: BootstrapConfig) =>
    JSON.stringify({
      ...value,
      registerDatabaseCertificate: value.registerDatabaseCertificate ?? false,
      target: value.target ?? "cloudflare",
      managedSource: undefined,
    })
  if (
    comparable(receipt.config) !== comparable(config) ||
    (receipt.config.managedSource === true && config.managedSource !== true)
  )
    throw new BootstrapError(
      "Bootstrap configuration/source differs from its saved receipt. Resume with the original selected source and configuration."
    )
}

/** Non-mutating authority/catalog check and policy preview; zone IDs are resolved only by explicit apply. */
export async function planBootstrap(
  config: BootstrapConfig,
  bootstrapToken: string,
  deps = dependencies
) {
  const groups = await api(
    deps,
    bootstrapToken,
    "/user/tokens/permission_groups",
    z.array(groupSchema)
  )
  // Validate every required group before creating even the discovery credential.
  const sample = tokenPolicies(config, groups, ["0".repeat(32)], true)
  return {
    version: 1,
    accountId: config.accountId,
    hostnames: [config.webHost, config.apiHost],
    sourceRevision: config.revision,
    discovery: sample.discovery,
    deploymentPermissions: [
      ...deploymentGroups(config).account,
      ...deploymentGroups(config).zone,
    ],
    miniApps: config.miniApps,
    managedSource: config.managedSource ?? false,
    zonesResolvedDuringApply: true,
  }
}

/**
 * Takes the state directory's lock, which one bootstrap holds while it runs.
 *
 * @throws BootstrapError when another bootstrap holds it, or an interrupted
 * one left it behind.
 */
function lockStateDirectory(lock: string): number {
  try {
    return openSync(lock, "wx", 0o600)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new BootstrapError(
        `${lock} exists: another bootstrap is running, or one was interrupted. Remove it only after confirming the process ID it records has ended; keep every other file.`
      )
    throw error
  }
}

/** Creates scoped tokens in private local Terraform state, resumes only matching state, and writes a value-free receipt plus private dotenv handoff. */
export async function applyBootstrap(
  config: BootstrapConfig,
  bootstrapToken: string,
  directory: string,
  deps = dependencies
) {
  const stateDir = resolve(directory)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(stateDir)
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new BootstrapError(
      "Bootstrap state directory must be private (mode 0700) and not a symlink."
    )
  const lock = join(stateDir, "bootstrap.lock")
  const fd = lockStateDirectory(lock)
  try {
    writeFileSync(fd, String(process.pid))
    const receiptPath = join(stateDir, "receipt.json")
    const root = join(stateDir, "terraform")
    if (
      existsSync(root) &&
      (!lstatSync(root).isDirectory() ||
        (process.platform !== "win32" && (lstatSync(root).mode & 0o077) !== 0))
    )
      throw new BootstrapError(
        "Bootstrap Terraform directory must be private and not a symlink."
      )
    const state = join(root, "terraform.tfstate")
    let receipt: Receipt = {
      version: 1,
      config,
      phase: "prepared",
      zoneIds: [],
    }
    if (existsSync(receiptPath)) {
      receipt = receiptSchema.parse(JSON.parse(privateFile(receiptPath)))
      checkConfig(receipt, config)
      receipt.config = config
      if (["ready", "complete"].includes(receipt.phase) && !existsSync(state))
        throw new BootstrapError(
          "Bootstrap Terraform state is missing. Restore it before retrying; tokens cannot be recovered from their IDs."
        )
    } else if (existsSync(state))
      throw new BootstrapError(
        "Bootstrap state exists without its source/instance receipt. Restore both files together."
      )
    let values = readValues(state)
    await reconcile(deps, bootstrapToken, config, values)
    const groups = await api(
      deps,
      bootstrapToken,
      "/user/tokens/permission_groups",
      z.array(groupSchema)
    )
    tokenPolicies(config, groups, ["0".repeat(32)], true)
    writePrivateJson(receiptPath, receipt)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const name of [
      "main.tf",
      ".terraform.lock.hcl",
      "empty.tfrc",
      "terraform.tfvars.json",
      "terraform.tfstate",
      "terraform.tfstate.backup",
      "bootstrap.tfplan",
    ]) {
      const path = join(root, name)
      if (existsSync(path) && !lstatSync(path).isFile())
        throw new BootstrapError("Bootstrap files must not be symbolic links.")
    }
    const configuration = join(REPOSITORY, "roots/bootstrap")
    for (const name of ["main.tf", ".terraform.lock.hcl"])
      copyFileSync(join(configuration, name), join(root, name))
    const env = isolatedProcessEnv({
      CLOUDFLARE_API_TOKEN: bootstrapToken,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      TF_CLI_CONFIG_FILE: join(root, "empty.tfrc"),
    })
    writeFileSync(join(root, "empty.tfrc"), "", { mode: 0o600 })
    await deps.run(
      [
        "terraform",
        `-chdir=${root}`,
        "init",
        "-input=false",
        "-lockfile=readonly",
      ],
      env
    )
    const apply = async (tokens: Tokens) => {
      const previousValues = readValues(state)
      await reconcile(deps, bootstrapToken, config, previousValues)
      writePrivateJson(join(root, "terraform.tfvars.json"), { tokens })
      const planPath = join(root, "bootstrap.tfplan")
      try {
        await deps.run(
          [
            "terraform",
            `-chdir=${root}`,
            "plan",
            "-input=false",
            `-out=${planPath}`,
          ],
          env
        )
        const plan = z
          .object({
            resource_changes: z
              .array(
                z.object({
                  address: z.string(),
                  type: z.string(),
                  change: z.object({ actions: z.array(z.string()) }),
                })
              )
              .optional(),
          })
          .parse(
            JSON.parse(
              await deps.run(
                ["terraform", `-chdir=${root}`, "show", "-json", planPath],
                env
              )
            )
          )
        for (const resource of plan.resource_changes ?? []) {
          const key = resource.address.match(/\["([^"\]]+)"\]$/u)?.[1]
          if (
            key &&
            previousValues[key] &&
            resource.change.actions.includes("create")
          )
            throw new BootstrapError(
              "Terraform would recreate a previously saved token. Recover its original state/authority before retrying."
            )
          if (
            resource.type !== "cloudflare_api_token" ||
            !/^cloudflare_api_token\.scoped\["(?:discovery|deployment|miniapps|managed-source|managed-events)"\]$/u.test(
              resource.address
            ) ||
            (resource.change.actions.includes("delete") &&
              resource.address !== 'cloudflare_api_token.scoped["discovery"]')
          )
            throw new BootstrapError(
              "Bootstrap plan would replace or delete a retained token or affect an unexpected resource. No changes were applied."
            )
        }
        await deps.run(
          ["terraform", `-chdir=${root}`, "apply", "-input=false", planPath],
          env
        )
      } finally {
        if (existsSync(planPath)) unlinkSync(planPath)
      }
      return readValues(state)
    }
    if (receipt.phase === "prepared" || receipt.phase === "discovery") {
      // Checkpoint the attempt before token creation; preserve partial state on failure.
      receipt.phase = "discovery"
      writePrivateJson(receiptPath, receipt)
      values = await apply(tokenPolicies(config, groups, [], true))
      if (!values.discovery)
        throw new BootstrapError(
          "Terraform did not retain the discovery token in private state."
        )
      receipt.zoneIds = await zones(deps, values.discovery.value, config)
      receipt.phase = "ready"
      writePrivateJson(receiptPath, receipt)
    }
    values = await apply(tokenPolicies(config, groups, receipt.zoneIds, false))
    if (
      !values.deployment ||
      (config.miniApps && !values.miniapps) ||
      (config.managedSource &&
        (!values["managed-source"] ||
          (config.target !== "gcp" && !values["managed-events"]))) ||
      values.discovery
    )
      throw new BootstrapError(
        "Scoped token handoff is incomplete. Preserve state and retry."
      )
    await verifyValues(deps, values)
    const credentialsFile = join(stateDir, "credentials.env")
    const content = `CLOUDFLARE_API_TOKEN=${JSON.stringify(values.deployment.value)}\n${config.miniApps ? `V3_CF_API_TOKEN=${JSON.stringify(values.miniapps.value)}\n` : ""}${config.managedSource ? `CLOUDFLARE_ARTIFACTS_API_TOKEN=${JSON.stringify(values["managed-source"].value)}\n` : ""}${values["managed-events"] ? `CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN=${JSON.stringify(values["managed-events"].value)}\n` : ""}`
    const temporary = `${credentialsFile}.${process.pid}.tmp`
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" })
    renameSync(temporary, credentialsFile)
    const result = {
      version: 1,
      accountId: config.accountId,
      sourceRevision: config.revision,
      zoneIds: receipt.zoneIds,
      tokenIds: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, value.id])
      ),
      credentialsFile,
    }
    writePrivateJson(join(stateDir, "result.json"), result)
    receipt.phase = "complete"
    writePrivateJson(receiptPath, receipt)
    return result
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}

const USAGE =
  "Usage: bootstrap.ts plan|apply --config FILE --bootstrap-file PRIVATE_ENV --state-dir PRIVATE_DIRECTORY [--source APP_CHECKOUT]\n--source may instead come from AZAD_SOURCE; without either it is the current directory."

function cliArguments() {
  try {
    return parseArgs({
      options: {
        config: { type: "string" },
        "bootstrap-file": { type: "string" },
        "state-dir": { type: "string" },
        source: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch {
    // An unknown option or a missing value: the usage says what is accepted.
    throw new BootstrapError(USAGE)
  }
}

async function main() {
  const { values, positionals } = cliArguments()
  if (values.help || positionals[0] === "help") {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (
    positionals.length !== 1 ||
    !["plan", "apply"].includes(positionals[0]) ||
    !values.config ||
    !values["bootstrap-file"] ||
    !values["state-dir"]
  )
    throw new BootstrapError(USAGE)
  const config = bootstrapConfigSchema.parse(
    JSON.parse(readFileSync(values.config, "utf8"))
  )
  const env = z
    .object({ CLOUDFLARE_BOOTSTRAP_API_TOKEN: z.string().trim().min(1) })
    .strict()
    .parse(parse(privateFile(values["bootstrap-file"])))
  const source = resolve(sourceOption(values.source) ?? ".")
  const head = await dependencies
    .run(["git", "-C", source, "rev-parse", "HEAD"], isolatedProcessEnv())
    .catch(() => {
      throw new BootstrapError(
        `${source} is not a Git checkout of the Azad app source. Pass it with --source or AZAD_SOURCE.`
      )
    })
  if (head.trim() !== config.revision)
    throw new BootstrapError(
      "Selected source revision differs from checkout HEAD."
    )
  const token = env.CLOUDFLARE_BOOTSTRAP_API_TOKEN
  const result =
    positionals[0] === "plan"
      ? await planBootstrap(config, token)
      : await applyBootstrap(config, token, values["state-dir"])
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
if (import.meta.main) {
  // Terraform states/backups and plans are sensitive, even with sensitive outputs.
  process.umask(0o077)
  try {
    await main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof BootstrapError ? error.message : "Token bootstrap failed. Check private input formats, token-management authority and preserved state; credential details are not logged."}\n`
    )
    process.exitCode = 1
  }
}
