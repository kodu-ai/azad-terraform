import { randomBytes, sign } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { isIPv4 } from "node:net"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { parse } from "dotenv"
import { z } from "zod"
import { NEON_DATABASE_CA, neonCaPem } from "./database-ca"
import {
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
  upsertSettings,
  writePrivate,
  type InstanceTerraform,
} from "./instance"
import { readEnvFile, type Fetcher } from "./lib"
import {
  requireSource,
  SettingsRefused,
  sourceOption,
  sourceSettings,
  SourceError,
  type AppSettings,
  type Source,
} from "./source"

/**
 * Cloudflare installation (Workers, Pages, Hyperdrive) of one customer
 * instance, with Neon or other PostgreSQL (`--root postgres`) or Cloud SQL
 * (`--root cloudsql`, the default), deployed from an Azad app source
 * checkout (`--source`, see ./source.ts):
 *
 *   bun scripts/cloudflare.ts setup --database-provider postgres \
 *     --web-host board.example.com --credentials PRIVATE_ENV \
 *     --root postgres --source APP_CHECKOUT --instance-dir DIR
 *   bun scripts/cloudflare.ts init|output|show|state ... --root ROOT --instance-dir DIR
 *   bun scripts/cloudflare.ts refresh|plan|apply|destroy ... --root ROOT \
 *     --source APP_CHECKOUT --instance-dir DIR
 *
 * Every per-install file is in the instance directory (see ./instance.ts):
 * the private settings (`DIR/.env`), and the root's state, variables, saved
 * plans and the deploy step's state under `DIR/terraform/<root name>/`.
 */
class SetupError extends Error {
  name = "SetupError"
}

const inputSchema = z.object({
  projectId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u)
    .optional(),
  databaseProvider: z.enum(["cloudsql", "postgres"]).optional(),
  webHost: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/u),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  credentials: z.string().min(1),
  accountId: z
    .string()
    .regex(/^[a-f0-9]{32}$/u)
    .optional(),
  runnerCidr: z.string().optional(),
  httpProxyConfigured: z.boolean().optional(),
})
const credentialsSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_APP_ID: z.string().regex(/^\d+$/u),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
})

function ipv4Cidr(
  value: string,
  source: "runner" | "cloudflare" = "runner"
): string {
  const [ip, prefix, extra] = value.split("/")
  if (
    !isIPv4(ip) ||
    !prefix ||
    !/^\d+$/u.test(prefix) ||
    Number(prefix) > 32 ||
    extra !== undefined
  ) {
    throw new SetupError(
      source === "cloudflare"
        ? "Cloudflare returned an invalid published IPv4 range. Check the published range source and retry."
        : "An IPv4 CIDR is required. Use --runner-cidr for the machine that will run Terraform apply."
    )
  }
  return value
}

async function request(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string> = {}
) {
  let response: Response
  try {
    response = await fetcher(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new SetupError(
      `Setup could not reach ${new URL(url).hostname}. Check network/proxy settings and retry.`
    )
  }
  if (!response.ok)
    throw new SetupError(
      `Setup lookup failed at ${new URL(url).hostname} (HTTP ${response.status}). Check service availability and access permissions.`
    )
  return response
}

const cloudflareApi = "https://api.cloudflare.com/client/v4"
const zoneId = z.string().regex(/^[a-f0-9]{32}$/u)

/** Reads one Cloudflare API result with the deployment token. */
async function cloudflareGet<T>(
  fetcher: Fetcher,
  token: string,
  path: string,
  schema: z.ZodType<T>
): Promise<T> {
  const parsed = z
    .object({ success: z.literal(true), result: schema })
    .safeParse(
      await (
        await request(fetcher, `${cloudflareApi}${path}`, {
          Authorization: `Bearer ${token}`,
        })
      )
        .json()
        .catch(() => undefined)
    )
  if (!parsed.success)
    throw new SetupError("Cloudflare returned unexpected zone metadata.")
  return parsed.data.result
}

/** The account's zone serving `host`: the longest matching zone name, if any. */
async function cloudflareZone(
  fetcher: Fetcher,
  token: string,
  accountId: string,
  host: string
): Promise<{ id: string; name: string } | undefined> {
  const labels = host.toLowerCase().split(".")
  for (let offset = 0; offset < labels.length - 1; offset++) {
    const [zone] = await cloudflareGet(
      fetcher,
      token,
      `/zones?name=${encodeURIComponent(labels.slice(offset).join("."))}&account.id=${accountId}`,
      z.array(z.object({ id: zoneId, name: z.string() }))
    )
    if (zone) return zone
  }
  return undefined
}

/**
 * Zone of each Board hostname, for Terraform's hostname route reservations
 * (modules/cloudflare/host-routes).
 *
 * @throws When a hostname is not in a zone of the selected account.
 */
export async function hostZones(
  fetcher: Fetcher,
  token: string,
  accountId: string,
  hosts: string[]
): Promise<Record<string, string>> {
  const zones: Record<string, string> = {}
  for (const host of hosts) {
    const zone = await cloudflareZone(fetcher, token, accountId, host)
    if (!zone)
      throw new SetupError(
        `${host} is not in a Cloudflare zone of this account. Add its zone to the account, then rerun setup.`
      )
    zones[host] = zone.id
  }
  return zones
}

/** Clerk's production CNAMEs, split into those Terraform creates and those already in DNS.
 * Reads Clerk with the instance secret key and Cloudflare with the deployment
 * token (Zone Read + DNS Edit on the web host's zone). Development keys need no DNS.
 */
export async function clerkDns(
  fetcher: Fetcher,
  secretKey: string,
  cloudflareToken: string,
  accountId: string
): Promise<
  | { zone_id: string; zone: string; records: Record<string, string> }
  | { manual: Record<string, string> }
  | undefined
> {
  if (!secretKey.startsWith("sk_live_")) return undefined
  const domains = z
    .object({
      data: z.array(
        z.object({
          name: z.string(),
          is_satellite: z.boolean(),
          cname_targets: z
            .array(z.object({ host: z.string(), value: z.string() }))
            .nullish(),
        })
      ),
    })
    .safeParse(
      await (
        await request(fetcher, "https://api.clerk.com/v1/domains", {
          Authorization: `Bearer ${secretKey}`,
        })
      )
        .json()
        .catch(() => undefined)
    )
  if (!domains.success)
    throw new SetupError("Clerk returned unexpected domain metadata.")
  const primary = domains.data.data.find((domain) => !domain.is_satellite)
  const targets = Object.fromEntries(
    (primary?.cname_targets ?? []).map((target) => [
      target.host.toLowerCase().replace(/\.$/u, ""),
      target.value.toLowerCase().replace(/\.$/u, ""),
    ])
  )
  if (!primary || !Object.keys(targets).length) return undefined
  const cloudflare = async <T>(path: string, schema: z.ZodType<T>) =>
    await cloudflareGet(fetcher, cloudflareToken, path, schema)
  const zone = await cloudflareZone(
    fetcher,
    cloudflareToken,
    accountId,
    primary.name
  )
  if (!zone) return { manual: targets }
  const records: Record<string, string> = {}
  for (const [host, value] of Object.entries(targets)) {
    const existing = await cloudflare(
      `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`,
      z.array(z.object({ type: z.string(), content: z.string() }))
    )
    if (!existing.length) records[host] = value
    else if (
      existing.some(
        (record) =>
          record.type !== "CNAME" ||
          record.content.toLowerCase().replace(/\.$/u, "") !== value
      )
    )
      throw new SetupError(
        `DNS already has a different record for ${host}. Clerk needs a CNAME to ${value}; fix it in Cloudflare, then rerun.`
      )
  }
  return { zone_id: zone.id, zone: zone.name, records }
}

const githubAppSchema = z.object({
  id: z.number(),
  slug: z.string().regex(/^[a-z0-9-]+$/u),
  client_id: z.string().regex(/^[a-zA-Z0-9._-]+$/u),
})

/** Reads the App's slug and client ID from GitHub with an App JWT signed by its private key. */
async function githubApp(
  fetcher: Fetcher,
  credentials: z.infer<typeof credentialsSchema>
) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (
    value:
      | { alg: string; typ: string }
      | { iat: number; exp: number; iss: string }
  ) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 300, iss: credentials.GITHUB_APP_ID })}`
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    credentials.GITHUB_APP_PRIVATE_KEY
  ).toString("base64url")
  const appResponse = await request(fetcher, "https://api.github.com/app", {
    Authorization: `Bearer ${unsigned}.${signature}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Azad-setup",
    "X-GitHub-Api-Version": "2022-11-28",
  })
  const appResult = githubAppSchema.safeParse(
    await appResponse.json().catch(() => {
      throw new SetupError("GitHub returned invalid App metadata JSON.")
    })
  )
  if (!appResult.success)
    throw new SetupError(
      "GitHub returned unexpected App metadata. Check API availability and retry."
    )
  if (String(appResult.data.id) !== credentials.GITHUB_APP_ID)
    throw new SetupError(
      "The GitHub private key and App ID do not identify the same app."
    )
  return appResult.data
}

/**
 * AZAD_SELF_HOST_GITHUB_APP_PENDING=1: the App does not exist yet, so nothing
 * is read from GitHub. The placeholders must already name a slug and client ID.
 */
function pendingGitHubApp(env: Record<string, string>) {
  const pending = z
    .object({
      GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/u),
      GITHUB_APP_CLIENT_ID: z.string().regex(/^[a-zA-Z0-9._-]+$/u),
    })
    .safeParse(env)
  if (!pending.success)
    throw new SetupError(
      "With AZAD_SELF_HOST_GITHUB_APP_PENDING=1, add placeholder GITHUB_APP_SLUG and GITHUB_APP_CLIENT_ID values to the credential file."
    )
  return {
    slug: pending.data.GITHUB_APP_SLUG,
    client_id: pending.data.GITHUB_APP_CLIENT_ID,
  }
}

/**
 * Terraform's storage variable from the credential file's STORAGE_* settings,
 * as the app selects them: undefined keeps this installation's R2 buckets; an
 * operator-owned bucket contributes its non-secret identity while its keys
 * stay in the private file.
 */
export function setupStorage(env: Record<string, string>, app: AppSettings) {
  const settings = Object.fromEntries(
    [
      "STORAGE_ADAPTER",
      "STORAGE_BUCKET",
      "STORAGE_RELEASES_BUCKET",
      "STORAGE_ENDPOINT",
      "STORAGE_REGION",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ].map((key) => [key, env[key]?.trim() ?? ""])
  )
  let storage: ReturnType<AppSettings["storage"]>
  try {
    storage = app.storage(settings)
  } catch (error) {
    if (error instanceof SettingsRefused) throw new SetupError(error.message)
    throw error
  }
  if (storage.kind === "r2") return undefined
  return {
    adapter: storage.kind,
    bucket: storage.bucket,
    releases_bucket: env.STORAGE_RELEASES_BUCKET?.trim()
      ? storage.releasesBucket
      : undefined,
    endpoint: storage.endpoint,
    region: storage.region,
  }
}

/** Reads account/app metadata and public network information, without provisioning.
 * Returns a non-secret Terraform configuration plus the private settings
 * setup derives (`additions`), and the credential file with them appended
 * (`installerEnv`). Caller must retain the generated webhook secret and
 * configure it on GitHub.
 */
export async function prepareCloudflare(
  raw: z.infer<typeof inputSchema>,
  appSettings: AppSettings,
  fetcher: Fetcher = fetch
) {
  const input = inputSchema.parse(raw)
  const usePostgres = input.databaseProvider === "postgres"
  if (!usePostgres && !input.projectId)
    throw new SetupError("Cloud SQL requires --project-id.")
  if (!usePostgres && input.httpProxyConfigured && !input.runnerCidr) {
    throw new SetupError(
      "An HTTP proxy is configured. Supply --runner-cidr for direct PostgreSQL TCP egress; an HTTP trace would identify the proxy instead."
    )
  }
  const env = parse(input.credentials)
  if (usePostgres && !env.DATABASE_URL?.trim())
    throw new SetupError(
      "Add the direct DATABASE_URL with TLS to the selected private credential file."
    )
  const credentials = credentialsSchema.safeParse(env)
  if (!credentials.success)
    throw new SetupError(
      "Complete the seven fields in credentials.env.example before setup."
    )
  let accountId = input.accountId
  if (!accountId) {
    const response = await request(
      fetcher,
      "https://api.cloudflare.com/client/v4/accounts?per_page=50",
      { Authorization: `Bearer ${credentials.data.CLOUDFLARE_API_TOKEN}` }
    )
    const accountResult = z
      .object({
        success: z.literal(true),
        result: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{32}$/u) })),
        result_info: z
          .object({ total_pages: z.number().optional() })
          .optional(),
      })
      .safeParse(
        await response.json().catch(() => {
          throw new SetupError(
            "Cloudflare returned invalid account metadata JSON."
          )
        })
      )
    if (!accountResult.success)
      throw new SetupError(
        "Cloudflare returned unexpected account metadata. Check API availability and retry."
      )
    const accounts = accountResult.data
    if (
      accounts.result.length !== 1 ||
      (accounts.result_info?.total_pages ?? 1) > 1
    )
      throw new SetupError(
        "The token does not select one Cloudflare account. Rerun with --account-id from the customer dashboard."
      )
    accountId = accounts.result[0].id
  }
  const githubAppPending = env.AZAD_SELF_HOST_GITHUB_APP_PENDING?.trim() === "1"
  const app = githubAppPending
    ? pendingGitHubApp(env)
    : await githubApp(fetcher, credentials.data)
  const authorizedNetworks: Record<string, string> = {}
  if (!usePostgres) {
    const rangesResponse = await request(
      fetcher,
      "https://www.cloudflare.com/ips-v4"
    )
    const ranges = (await rangesResponse.text())
      .trim()
      .split(/\s+/u)
      .map((cidr) => ipv4Cidr(cidr, "cloudflare"))
    let runnerCidr = input.runnerCidr
    if (!runnerCidr) {
      const traceResponse = await request(
        fetcher,
        "https://www.cloudflare.com/cdn-cgi/trace"
      )
      const ip = (await traceResponse.text())
        .split("\n")
        .find((line) => line.startsWith("ip="))
        ?.slice(3)
      if (!ip || !isIPv4(ip))
        throw new SetupError(
          "Could not detect a public IPv4. Supply --runner-cidr for the machine that will run Terraform apply."
        )
      runnerCidr = `${ip}/32`
    }
    for (const [index, cidr] of ranges.entries())
      authorizedNetworks[`cloudflare-${index + 1}`] = cidr
    authorizedNetworks.runner = ipv4Cidr(runnerCidr)
  }
  const clerk = await clerkDns(
    fetcher,
    credentials.data.CLERK_SECRET_KEY,
    credentials.data.CLOUDFLARE_API_TOKEN,
    accountId
  )
  const webhookSecret =
    env.GITHUB_WEBHOOK_SECRET?.trim() || randomBytes(32).toString("hex")
  const additions = new Map<string, string>()
  if (!githubAppPending) {
    additions.set("GITHUB_APP_SLUG", app.slug)
    additions.set("GITHUB_APP_CLIENT_ID", app.client_id)
  }
  if (!env.GITHUB_WEBHOOK_SECRET?.trim())
    additions.set("GITHUB_WEBHOOK_SECRET", webhookSecret)
  if (env.V3_CF_API_TOKEN?.trim() || env.CLOUDFLARE_ARTIFACTS_API_TOKEN?.trim())
    additions.set("V3_CF_ACCOUNT_ID", accountId)
  // Each installation's managed project source gets its own Artifacts
  // namespace; the API's default is shared by every instance in an account.
  if (
    env.CLOUDFLARE_ARTIFACTS_API_TOKEN?.trim() &&
    !env.V3_CF_ARTIFACTS_NAMESPACE?.trim()
  )
    additions.set(
      "V3_CF_ARTIFACTS_NAMESPACE",
      `${appSettings.resourcePrefix(`https://api.${input.webHost}`)}-control`
    )
  // Self-hosted managed source without a GitHub backup repository relies on
  // Cloudflare Artifacts' own durability; the API's backup rule is opted out.
  if (
    env.CLOUDFLARE_ARTIFACTS_API_TOKEN?.trim() &&
    !env.V3_CONTROL_BACKUP_GITHUB_REPO?.trim() &&
    !env.V3_CONTROL_BACKUP?.trim()
  )
    additions.set("V3_CONTROL_BACKUP", "none")
  if (env.V3_CF_API_TOKEN?.trim())
    additions.set("AZAD_SELF_HOST_MINIAPPS", "enabled")
  else additions.set("AZAD_SELF_HOST_MINIAPPS", "disabled")
  // Original dotenv quoting/PEM newlines stay intact. Derived additions contain
  // only API-validated identifiers, hex randomness, and fixed literals.
  const installerEnv = `${input.credentials.trim()}\n${[...additions].map(([key, value]) => `${key}=${value}`).join("\n")}\n`
  const apiOrigin = `https://api.${input.webHost}`
  const webOrigin = `https://${input.webHost}`
  const storage = setupStorage(env, appSettings)
  const zones = await hostZones(
    fetcher,
    credentials.data.CLOUDFLARE_API_TOKEN,
    accountId,
    [input.webHost, `api.${input.webHost}`]
  )
  try {
    appSettings.validate("cloudflare", {
      ...parse(installerEnv),
      CLOUDFLARE_ACCOUNT_ID: accountId,
      AZAD_SELF_HOST_API_ORIGIN: apiOrigin,
      AZAD_SELF_HOST_WEB_ORIGIN: webOrigin,
      DATABASE_URL: usePostgres
        ? env.DATABASE_URL
        : "postgresql://azad:placeholder@192.0.2.1:5432/azad?sslmode=require",
    })
  } catch (error) {
    if (error instanceof SettingsRefused)
      throw new SetupError(`The settings are not deployable: ${error.message}`)
    throw error
  }
  return {
    installerEnv,
    additions: Object.fromEntries(additions),
    generatedWebhook: !env.GITHUB_WEBHOOK_SECRET?.trim(),
    clerkDns: clerk,
    onboarding: {
      web_origin: webOrigin,
      api_origin: apiOrigin,
      clerk_webhook: `${apiOrigin}/api/clerk/webhooks`,
      github_callback: `${apiOrigin}/api/github/install/callback`,
      github_webhook: `${apiOrigin}/api/github/webhooks`,
      github_app: githubAppPending
        ? "pending: register the GitHub App, then replace the GITHUB_APP_* placeholders"
        : `https://github.com/apps/${app.slug}`,
      mini_apps: env.V3_CF_API_TOKEN?.trim()
        ? "configured; live deployment still needs verification"
        : "not configured; add V3_CF_API_TOKEN to enable Workers/D1 apps",
      managed_control: env.CLOUDFLARE_ARTIFACTS_API_TOKEN?.trim()
        ? "configured; verify namespace access and private backup repository before first project publish"
        : "not configured; supply Artifacts tokens, chosen namespace and private GitHub backup repository for managed project source",
      external_steps: [
        "Configure Clerk DNS, allowed origins and webhook",
        "Configure/install the GitHub App and set its webhook secret from the private file",
        "Confirm Cloudflare zones and account service entitlements",
        "Configure a project model resource and pair an agent machine after first login",
        "Complete the self-host first-use checklist including rerun/upgrade",
      ],
    },
    tfvars: {
      gcp: usePostgres
        ? undefined
        : {
            project_id: input.projectId,
            authorized_networks: authorizedNetworks,
          },
      cloudflare: {
        account_id: accountId,
        api_origin: apiOrigin,
        web_origin: webOrigin,
      },
      deployment: { revision: input.revision },
      storage,
      github_app_pending: githubAppPending || undefined,
      host_zones: zones,
      database_ca: env.AZAD_SELF_HOST_DATABASE_CA?.trim() || undefined,
      clerk_dns:
        clerk && "records" in clerk && Object.keys(clerk.records).length
          ? { zone_id: clerk.zone_id, records: clerk.records }
          : undefined,
    },
  }
}

/** The deploy step's state directory, in the instance's Terraform directory. */
const STATE_DIRECTORY = "installer-state"
const DRIVER = `bun --no-env-file ${join(REPOSITORY, "scripts/cloudflare.ts")}`

/**
 * Writes setup's outputs into the instance once. The instance's `.env` is the
 * private settings file the deploy reads: when `credentials` is that file
 * (the installer), setup's derived settings are added to it; any other
 * credential file is copied there with them, never over an existing `.env`.
 * The variables name that file and the deploy step's state directory in the
 * instance. Refuses replacement so an existing webhook secret or customer
 * customization cannot disappear on a repeated setup invocation.
 */
export function saveCloudflare(
  files: InstanceTerraform,
  result: Awaited<ReturnType<typeof prepareCloudflare>>,
  credentials: string
) {
  if (existsSync(files.vars))
    throw new SetupError(
      `${files.vars} already exists. Edit it in place, or use refresh after changing the source checkout.`
    )
  const inPlace = resolve(credentials) === files.settings
  if (!inPlace && existsSync(files.settings))
    throw new SetupError(
      `${files.settings} already exists. Pass it as --credentials, or choose another --instance-dir.`
    )
  mkdirSync(files.directory, { recursive: true, mode: 0o700 })
  if (inPlace) upsertSettings(files.settings, result.additions)
  else
    writeFileSync(files.settings, result.installerEnv, {
      mode: 0o600,
      flag: "wx",
    })
  const tfvars = {
    ...result.tfvars,
    deployment: {
      ...result.tfvars.deployment,
      env_file: files.settings,
      state_directory: join(files.directory, STATE_DIRECTORY),
    },
  }
  try {
    writeFileSync(files.vars, `${JSON.stringify(tfvars, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    })
  } catch (error) {
    if (!inPlace) unlinkSync(files.settings)
    throw error
  }
}

const varsSchema = z.looseObject({
  database_ca: z.literal(NEON_DATABASE_CA).optional(),
  deployment: z.looseObject({
    env_file: z.string(),
    revision: z.string(),
    state_directory: z.string(),
  }),
})

/** The instance's variables; their files must be absolute paths outside this repository. */
function cloudflareVars(files: InstanceTerraform) {
  if (!existsSync(files.vars))
    throw new SetupError(`Run setup first: ${files.vars} does not exist.`)
  const vars = varsSchema.parse(JSON.parse(readFileSync(files.vars, "utf8")))
  assertInstancePaths(vars.deployment, files.vars)
  return vars
}

const ROOT_NAMES = ["cloudsql", "postgres"] as const
const TERRAFORM_COMMANDS = [
  "init",
  "plan",
  "apply",
  "destroy",
  "output",
  "validate",
  "show",
  "state",
  "import",
  "console",
]
/** Commands that deploy, uninstall or validate the app: they need its source checkout. */
const SOURCE_COMMANDS = new Set([
  "setup",
  "refresh",
  "plan",
  "apply",
  "destroy",
])
/** Commands that evaluate the configuration: they pass a source checkout on when given one. */
const OPTIONAL_SOURCE_COMMANDS = new Set(["validate", "import", "console"])
const USAGE = `Usage: cloudflare.ts setup --database-provider cloudsql|postgres [--project-id ID] --web-host board.example.com --credentials PRIVATE_ENV [--account-id ID] [--runner-cidr CIDR] [--root cloudsql|postgres] --source APP_CHECKOUT --instance-dir DIR
       cloudflare.ts refresh|plan|apply|destroy [--root cloudsql|postgres] --source APP_CHECKOUT --instance-dir DIR [terraform arguments]
       cloudflare.ts init|output|show|state|validate|import|console [--root cloudsql|postgres] --instance-dir DIR [terraform arguments]
--source may instead come from AZAD_SOURCE.`

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const parsed = parseArgs({
    args,
    options: {
      "database-provider": { type: "string" },
      "project-id": { type: "string" },
      "web-host": { type: "string" },
      credentials: { type: "string" },
      "account-id": { type: "string" },
      "runner-cidr": { type: "string" },
      root: { type: "string", default: "cloudsql" },
      source: { type: "string" },
      "instance-dir": { type: "string" },
    },
    strict: ["setup", "refresh"].includes(command),
    allowPositionals: true,
  })
  const options = z
    .object({
      "database-provider": z.enum(["cloudsql", "postgres"]).optional(),
      "project-id": z.string().optional(),
      "web-host": z.string().optional(),
      credentials: z.string().optional(),
      "account-id": z.string().optional(),
      "runner-cidr": z.string().optional(),
      root: z.string().default("cloudsql"),
      source: z.string().optional(),
      "instance-dir": z.string().optional(),
    })
    .parse(parsed.values)
  if (!["setup", "refresh", ...TERRAFORM_COMMANDS].includes(command))
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
  const source: Source | undefined =
    SOURCE_COMMANDS.has(command) ||
    (OPTIONAL_SOURCE_COMMANDS.has(command) &&
      sourceOption(options.source) !== undefined)
      ? requireSource(options.source)
      : undefined
  const commandLine = (name: string) =>
    `${DRIVER} ${name} --root ${files.name} --instance-dir ${files.instance}`
  if (command === "setup") {
    if (
      !options.credentials ||
      !options["web-host"] ||
      !options["database-provider"] ||
      !source
    )
      throw new SetupError(USAGE)
    if (existsSync(files.vars))
      throw new SetupError(
        `${files.vars} already exists. Edit it in place or use refresh.`
      )
    if (options["database-provider"] !== files.name)
      throw new SetupError(
        `Select the Terraform root matching --database-provider: --root ${options["database-provider"]}.`
      )
    const result = await prepareCloudflare(
      {
        projectId: options["project-id"],
        databaseProvider: options["database-provider"],
        webHost: options["web-host"],
        credentials: readFileSync(options.credentials, "utf8"),
        revision: source.revision,
        accountId: options["account-id"],
        runnerCidr: options["runner-cidr"],
        httpProxyConfigured: [
          "HTTPS_PROXY",
          "https_proxy",
          "HTTP_PROXY",
          "http_proxy",
          "ALL_PROXY",
          "all_proxy",
        ].some((key) => Boolean(process.env[key]?.trim())),
      },
      sourceSettings(source)
    )
    saveCloudflare(files, result, options.credentials)
    const lines = [
      `Created ${files.vars}; the deploy reads the private settings in ${files.settings}.`,
    ]
    if (result.clerkDns && "records" in result.clerkDns)
      lines.push(
        Object.keys(result.clerkDns.records).length
          ? `Terraform will add Clerk's ${Object.keys(result.clerkDns.records).length} DNS records in ${result.clerkDns.zone}.`
          : "Clerk's DNS records already exist."
      )
    else if (result.clerkDns)
      lines.push(
        "Add Clerk's DNS records (CNAME) at the domain's DNS provider:",
        ...Object.entries(result.clerkDns.manual).map(
          ([host, value]) => `  ${host} → ${value}`
        )
      )
    if (result.tfvars.github_app_pending)
      lines.push(
        "GitHub App verification is deferred (AZAD_SELF_HOST_GITHUB_APP_PENDING=1): GitHub features stay off until the real App replaces the GITHUB_APP_* placeholders.",
        "When you register the App, use GITHUB_WEBHOOK_SECRET from the private file as its webhook secret."
      )
    else if (result.generatedWebhook)
      lines.push(
        "Set the generated GITHUB_WEBHOOK_SECRET from the private file in GitHub App settings before apply."
      )
    if (result.tfvars.storage)
      lines.push(
        `Files and Agent Connect releases go to your ${result.tfvars.storage.adapter} bucket ${result.tfvars.storage.bucket}; no R2 bucket is created.`
      )
    process.stdout.write(`${lines.join("\n")}\n`)
    return
  }
  if (command === "refresh" && source) {
    cloudflareVars(files)
    const vars = z
      .looseObject({ deployment: z.looseObject({ revision: z.string() }) })
      .parse(JSON.parse(readFileSync(files.vars, "utf8")))
    vars.deployment.revision = source.revision
    writePrivate(files.vars, `${JSON.stringify(vars, null, 2)}\n`)
    process.stdout.write(
      `Updated deployment.revision to ${source.revision} (${source.path}); customer settings and credentials are unchanged.\n`
    )
    return
  }
  const config = cloudflareVars(files)
  const env = readEnvFile(config.deployment.env_file)
  if (!env.CLOUDFLARE_API_TOKEN?.trim())
    throw new SetupError(
      "The selected installer file needs CLOUDFLARE_API_TOKEN."
    )
  if (command === "init")
    mkdirSync(files.directory, { recursive: true, mode: 0o700 })
  else assertInitialized(files, commandLine("init"))
  const forwarded = terraformArguments(command, forwardedArgs(args), files)
  const plan = command === "plan" ? planOutput(forwarded) : undefined
  // A failed plan must never leave an older plan where the apply looks.
  if (plan) rmSync(plan, { force: true })
  process.exitCode = Bun.spawnSync(
    ["terraform", `-chdir=${files.root}`, command, ...forwarded],
    {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        TF_VAR_database_url: env.DATABASE_URL ?? "",
        TF_VAR_database_ca_pem:
          config.database_ca && ["plan", "apply", "destroy"].includes(command)
            ? neonCaPem()
            : "",
        ...(source
          ? { TF_VAR_source_dir: source.path, AZAD_SOURCE: source.path }
          : {}),
        ...terraformEnvironment(files),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  ).exitCode
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof SetupError || error instanceof InstanceError || error instanceof SourceError ? error.message : "Cloudflare setup failed. Check input files, credential formats and external metadata; no credential values are logged."}\n`
    )
    process.exitCode = 1
  }
}
