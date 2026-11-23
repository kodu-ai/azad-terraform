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
  upsertSettings,
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
  backendEnvironment,
  cloudflareStore,
  configureBackend,
  installStore,
  readBackendRecord,
  withOperation,
  type TerraformRun,
} from "./state"
import {
  installer,
  ReleaseError,
  releaseOption,
  requireRelease,
  SettingsRefused,
  sourceSettings,
  type AppSettings,
  type Release,
} from "./source"

/**
 * Cloudflare installation (Workers, Pages, Hyperdrive) of one customer
 * instance, with Neon or other PostgreSQL (`--root postgres`) or Cloud SQL
 * (`--root cloudsql`, the default), deployed from an unpacked Azad release
 * (`--release`, see ./source.ts):
 *
 *   bun scripts/cloudflare.ts setup --database-provider postgres \
 *     --web-host board.example.com --credentials PRIVATE_ENV \
 *     --root postgres --release RELEASE_DIR --instance-dir DIR
 *   bun scripts/cloudflare.ts init|output|show|state ... --root ROOT --instance-dir DIR
 *   bun scripts/cloudflare.ts refresh|plan|apply|destroy|deploy ... --root ROOT \
 *     --release RELEASE_DIR --instance-dir DIR
 *
 * Every per-install file is in the instance directory (see ./instance.ts):
 * the private settings (`DIR/.env`), and the root's state, variables, saved
 * plans and the deploy step's state under `DIR/terraform/<root name>/`.
 */
/** A refusal whose message names inputs, paths and settings, never values. */
export class SetupError extends Error {
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
  version: z.string().min(1),
  credentials: z.string().min(1),
  accountId: z
    .string()
    .regex(/^[a-f0-9]{32}$/u)
    .optional(),
  runnerCidr: z.string().optional(),
  httpProxyConfigured: z.boolean().optional(),
  /** `--miniapps-domain`: the loader provider's Mini Apps domain, or `none`. */
  miniappsDomain: z.string().min(1),
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

const domainSchema = z
  .string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u)

/**
 * `--miniapps-domain` as a lowercase domain, or undefined for `none`.
 *
 * @throws SetupError for a value that is not a domain name, or one that is,
 *   contains or sits under a Board host: Mini App origins never share a host
 *   with the API or web app.
 */
export function miniappsDomain(
  value: string,
  hosts: string[]
): string | undefined {
  const domain = value.trim().toLowerCase().replace(/\.$/u, "")
  if (domain === "none") return undefined
  if (!domainSchema.safeParse(domain).success)
    throw new SetupError(
      "--miniapps-domain takes a domain name such as apps.example.com, or none."
    )
  for (const host of hosts)
    if (
      host === domain ||
      host.endsWith(`.${domain}`) ||
      domain.endsWith(`.${host}`)
    )
      throw new SetupError(
        `--miniapps-domain ${domain} must be apart from the API and web hosts: not one of them, above one or below one.`
      )
  return domain
}

/** The loader provider's Mini Apps domain and the zone of the account that holds it. */
export type MiniappsZone = {
  domain: string
  zone: { id: string; name: string }
  /** True below the zone's apex: Terraform orders an advanced certificate pack. */
  certificate: boolean
}

/**
 * Finds the zone of the account that holds the Mini Apps domain (the longest
 * matching zone name), with the deployment token. Below the zone's apex the
 * hosts need an advanced certificate, so the zone must have Advanced
 * Certificate Manager; the wildcard record Terraform creates must not exist
 * yet.
 *
 * @throws SetupError when no readable zone holds the domain, the zone lacks
 *   Advanced Certificate Manager, or DNS already has a `*.<domain>` record.
 */
export async function miniappsZone(
  fetcher: Fetcher,
  token: string,
  accountId: string,
  domain: string
): Promise<MiniappsZone> {
  const zone = await cloudflareZone(fetcher, token, accountId, domain)
  if (!zone)
    throw new SetupError(
      `${domain} is not in a Cloudflare zone of this account that CLOUDFLARE_API_TOKEN can read. Add the zone, or give the token Zone Read, DNS Edit and Workers Routes Edit on it, then rerun setup.`
    )
  const certificate = zone.name !== domain
  if (certificate) {
    let response: Response
    try {
      response = await fetcher(
        `${cloudflareApi}/zones/${zone.id}/ssl/certificate_packs/quota`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }
      )
    } catch {
      throw new SetupError(
        "Setup could not reach api.cloudflare.com. Check network/proxy settings and retry."
      )
    }
    if (response.status === 401 || response.status === 403)
      throw new SetupError(
        `CLOUDFLARE_API_TOKEN may not read the certificates of ${zone.name}. Mini Apps on ${domain}, below the zone's apex, need an advanced certificate: give the token SSL and Certificates Edit on ${zone.name}.`
      )
    const quota = z
      .object({
        success: z.literal(true),
        result: z.object({
          advanced: z.object({ allocated: z.number() }).nullish(),
        }),
      })
      .safeParse(await response.json().catch(() => undefined))
    if (!response.ok || !quota.success)
      throw new SetupError(
        `Setup could not read the certificate quota of ${zone.name} (HTTP ${response.status}). Check service availability and access permissions.`
      )
    if (!(quota.data.result.advanced?.allocated ?? 0))
      throw new SetupError(
        `${domain} is below the apex of the zone ${zone.name}, so its Mini App hosts need an advanced certificate for *.${domain}, which needs Advanced Certificate Manager on ${zone.name}. Turn it on in the Cloudflare dashboard (SSL/TLS, Edge Certificates), or use a domain that is a zone of its own.`
      )
  }
  const existing = await cloudflareGet(
    fetcher,
    token,
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(`*.${domain}`)}`,
    z.array(z.object({ type: z.string() }))
  )
  if (existing.length)
    throw new SetupError(
      `DNS already has a record for *.${domain}. Terraform creates a proxied AAAA 100:: record there for the Mini Apps; remove the existing one, then rerun setup.`
    )
  return { domain, zone, certificate }
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
  const apiOrigin = `https://api.${input.webHost}`
  const webOrigin = `https://${input.webHost}`
  const domain = miniappsDomain(input.miniappsDomain, [
    input.webHost,
    `api.${input.webHost}`,
  ])
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
  const storage = setupStorage(env, appSettings)
  if (domain && storage)
    throw new SetupError(
      "Mini Apps on the loader provider keep their releases and databases in this installation's R2 files bucket, so --miniapps-domain needs STORAGE_ADAPTER=r2 (the default). With your own bucket, pass --miniapps-domain none."
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
  // Mini Apps run on the loader provider under --miniapps-domain. With none,
  // a V3_CF_API_TOKEN keeps them as Workers with D1; without one they are off.
  const miniapps =
    domain &&
    (await miniappsZone(
      fetcher,
      credentials.data.CLOUDFLARE_API_TOKEN,
      accountId,
      domain
    ))
  if (miniapps) {
    additions.set("AZAD_SELF_HOST_MINIAPPS", "loader")
    additions.set("AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN", miniapps.domain)
  } else {
    additions.set(
      "AZAD_SELF_HOST_MINIAPPS",
      env.V3_CF_API_TOKEN?.trim() ? "enabled" : "disabled"
    )
    if (env.AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN?.trim())
      additions.set("AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN", "")
  }
  // Original dotenv quoting/PEM newlines stay intact. Derived additions contain
  // only API-validated identifiers, hex randomness, and fixed literals.
  const installerEnv = `${input.credentials.trim()}\n${[...additions].map(([key, value]) => `${key}=${value}`).join("\n")}\n`
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
    miniapps: miniapps || undefined,
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
      deployment: { revision: input.revision, version: input.version },
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
      `${files.vars} already exists. Edit it in place, or use refresh to move to another release.`
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
  cloudflare: z.looseObject({ account_id: z.string(), api_origin: z.string() }),
  deployment: z.looseObject({
    env_file: z.string(),
    revision: z.string(),
    version: z.string().optional(),
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
  "force-unlock",
]
/**
 * Commands that deploy, uninstall or validate the app, or hold the
 * installation's operation record (through the release's install-store.js):
 * they need the release.
 */
const RELEASE_COMMANDS = new Set([
  "setup",
  "refresh",
  "plan",
  "apply",
  "destroy",
  "deploy",
  "backup-keys",
  "import",
])
/** Commands that evaluate the configuration: they pass a release on when given one. */
const OPTIONAL_RELEASE_COMMANDS = new Set(["validate", "console"])
const USAGE = `Usage: cloudflare.ts setup --database-provider cloudsql|postgres [--project-id ID] --web-host board.example.com --miniapps-domain DOMAIN|none --credentials PRIVATE_ENV [--account-id ID] [--runner-cidr CIDR] [--root cloudsql|postgres] --release RELEASE_DIR --instance-dir DIR
       cloudflare.ts refresh|plan|apply|destroy|deploy|import [--root cloudsql|postgres] --release RELEASE_DIR --instance-dir DIR [--take-over OPERATION] [terraform arguments]
       cloudflare.ts backup-keys --out NEW_DIR [--root cloudsql|postgres] --release RELEASE_DIR --instance-dir DIR
       cloudflare.ts init|output|show|state|validate|console|force-unlock [--root cloudsql|postgres] --instance-dir DIR [terraform arguments]
--release names an unpacked Azad release and may instead come from AZAD_RELEASE. state mv|rm|push also needs it, and so does init with a backend_override.tf.`

/** Arguments that print the usage instead of running a command. */
export const HELP = new Set(["--help", "-h", "help"])

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (HELP.has(command)) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const parsed = parseArgs({
    args,
    options: {
      "database-provider": { type: "string" },
      "project-id": { type: "string" },
      "web-host": { type: "string" },
      "miniapps-domain": { type: "string" },
      credentials: { type: "string" },
      "account-id": { type: "string" },
      "runner-cidr": { type: "string" },
      root: { type: "string", default: "cloudsql" },
      release: { type: "string" },
      "instance-dir": { type: "string" },
      "take-over": { type: "string" },
      out: { type: "string" },
    },
    strict: ["setup", "refresh", "deploy", "backup-keys"].includes(command),
    allowPositionals: true,
  })
  const options = z
    .object({
      "database-provider": z.enum(["cloudsql", "postgres"]).optional(),
      "project-id": z.string().optional(),
      "web-host": z.string().optional(),
      "miniapps-domain": z.string().optional(),
      credentials: z.string().optional(),
      "account-id": z.string().optional(),
      "runner-cidr": z.string().optional(),
      root: z.string().default("cloudsql"),
      release: z.string().optional(),
      "instance-dir": z.string().optional(),
      "take-over": z.string().optional(),
      out: z.string().optional(),
    })
    .parse(parsed.values)
  if (
    ![
      "setup",
      "refresh",
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
  // The release is checked before anything is read from the network or
  // written. init needs it only to point the bucket at the installation's own
  // backend, under the operation record.
  const release: Release | undefined =
    RELEASE_COMMANDS.has(command) ||
    changingPhase(command, forwardedArgs(args)) !== undefined ||
    (command === "init" && existsSync(ownBackendFile(files))) ||
    (OPTIONAL_RELEASE_COMMANDS.has(command) &&
      releaseOption(options.release) !== undefined)
      ? requireRelease(options.release)
      : undefined
  const commandLine = (name: string) =>
    `${DRIVER} ${name} --root ${files.name} --instance-dir ${files.instance}`
  if (command === "setup") {
    if (
      !options.credentials ||
      !options["web-host"] ||
      !options["database-provider"] ||
      !release
    )
      throw new SetupError(USAGE)
    if (!options["miniapps-domain"])
      throw new SetupError(
        `setup needs --miniapps-domain: the domain Mini Apps serve under (a zone of this account, or a subdomain inside one, such as apps.example.com), or none.\n${USAGE}`
      )
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
        miniappsDomain: options["miniapps-domain"],
        credentials: readFileSync(options.credentials, "utf8"),
        revision: release.revision,
        version: release.version,
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
      sourceSettings(release)
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
    if (result.miniapps)
      lines.push(
        `Mini Apps run on https://<app>.${result.miniapps.domain}. Terraform adds a proxied wildcard record *.${result.miniapps.domain} in the zone ${result.miniapps.zone.name}${result.miniapps.certificate ? `, and an advanced certificate for ${result.miniapps.domain} and *.${result.miniapps.domain}` : ""}. To change the domain, edit AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN in ${files.settings}, then plan, apply and deploy.`
      )
    else
      lines.push(
        result.additions.AZAD_SELF_HOST_MINIAPPS === "enabled"
          ? "Mini Apps run as Workers with D1 through V3_CF_API_TOKEN (AZAD_SELF_HOST_MINIAPPS=enabled)."
          : "Mini Apps are off (AZAD_SELF_HOST_MINIAPPS=disabled)."
      )
    if (result.tfvars.storage)
      lines.push(
        `Files and Agent Connect releases go to your ${result.tfvars.storage.adapter} bucket ${result.tfvars.storage.bucket}; no R2 bucket is created.`
      )
    process.stdout.write(`${lines.join("\n")}\n`)
    return
  }
  if (command === "refresh" && release) {
    cloudflareVars(files)
    const vars = z
      .looseObject({
        deployment: z.looseObject({
          revision: z.string(),
          version: z.string().optional(),
        }),
      })
      .parse(JSON.parse(readFileSync(files.vars, "utf8")))
    vars.deployment.revision = release.revision
    vars.deployment.version = release.version
    writePrivate(files.vars, `${JSON.stringify(vars, null, 2)}\n`)
    process.stdout.write(
      `Updated deployment to release ${release.version} (${release.revision}, ${release.path}); customer settings and credentials are unchanged.\n`
    )
    return
  }
  const config = cloudflareVars(files)
  const env = readEnvFile(config.deployment.env_file)
  const token = env.CLOUDFLARE_API_TOKEN?.trim()
  if (!token)
    throw new SetupError(
      "The selected installer file needs CLOUDFLARE_API_TOKEN."
    )
  const store = cloudflareStore(
    config.cloudflare.account_id,
    config.cloudflare.api_origin
  )
  const initCommand = commandLine("init")
  const forwardedRaw = forwardedArgs(args)
  // Without a record (before init) Terraform gets no backend credentials.
  const record =
    command === "init" ? undefined : readBackendRecord(files, initCommand)
  const backendEnv = () =>
    command === "init" || !record
      ? {}
      : backendEnvironment(record, token, initCommand)
  let initRecord: Awaited<ReturnType<typeof configureBackend>> | undefined
  // With a backend_override.tf, Terraform runs in the installation's copy of
  // the root with that backend, and without the bucket's R2 credentials.
  const own = ownBackend(files)
  const runner =
    (where: { root: string; data: string }, bucket: boolean): TerraformRun =>
    (terraformArgs, run = {}) => {
      const result = Bun.spawnSync(
        ["terraform", `-chdir=${where.root}`, ...terraformArgs],
        {
          env: {
            ...process.env,
            CLOUDFLARE_API_TOKEN: token,
            TF_VAR_database_url: env.DATABASE_URL ?? "",
            // The .env is the one place the Mini Apps domain is set.
            TF_VAR_miniapp_base_domain: loaderDomain(env),
            TF_VAR_database_ca_pem:
              config.database_ca &&
              ["plan", "apply", "destroy"].includes(terraformArgs[0] ?? "")
                ? neonCaPem()
                : "",
            ...(release
              ? { TF_VAR_release_dir: release.path, AZAD_RELEASE: release.path }
              : {}),
            TF_DATA_DIR: where.data,
            ...(!bucket
              ? {}
              : initRecord
                ? backendEnvironment(initRecord, token, initCommand)
                : backendEnv()),
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
  const terraform = own
    ? runner(own, false)
    : runner({ root: files.root, data: files.data }, true)
  const runs = own && {
    bucket: runner(bucketConfiguration(files), true),
    own: terraform,
  }
  const app =
    release &&
    installStore(release, {
      store,
      kind: "cloudflare",
      env_file: config.deployment.env_file,
      state_directory: config.deployment.state_directory,
    })
  if (command === "init") {
    mkdirSync(files.directory, { recursive: true, mode: 0o700 })
    initRecord = await configureBackend(files, store, { token })
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
    const status = terraform([
      "init",
      ...terraformArguments("init", forwardedRaw, files),
    ]).status
    if (status === 0) assertStateHere(terraform, files, initCommand)
    process.exitCode = status
    return
  }
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
  checkState()
  /** The full installer handoff: Terraform's outputs, the revision and the database URL. */
  const handoff = (lease: string) => {
    const outputs = terraformOutputs(terraform)
    if (!outputs.deploy)
      throw new SetupError(
        "This installation has no deployment (deployment.enabled is false)."
      )
    const held = leaseSchema.parse(JSON.parse(lease))
    return {
      ...outputs.deploy,
      // This machine's files: the output names those of the last apply.
      env_file: config.deployment.env_file,
      state_directory: config.deployment.state_directory,
      revision: config.deployment.revision,
      database_url: outputs.database_url ?? env.DATABASE_URL ?? "",
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
    if (!app || !release) throw new SetupError(USAGE)
    assertDeploys(release, config.deployment.revision, commandLine("refresh"))
    // The app routes the Mini Apps domain the .env names; its DNS record and
    // certificate are Terraform's, so they must already be applied.
    const applied = terraformOutputs(terraform).miniapps?.domain ?? ""
    if (applied !== loaderDomain(env))
      throw new SetupError(
        `The Mini Apps domain in ${config.deployment.env_file} (${loaderDomain(env) || "none"}) differs from the one Terraform last applied (${applied || "none"}). Run plan and apply first, then deploy.`
      )
    process.exitCode = withOperation(
      app,
      "deploy",
      { takeOver: options["take-over"], revision: config.deployment.revision },
      (lease) => {
        checkState()
        const input = handoff(lease)
        app.publish(lease, JSON.stringify(input), REPOSITORY)
        return Bun.spawnSync(
          [
            process.execPath,
            "--no-env-file",
            installer(release, "cloudflare-install"),
            "install",
          ],
          {
            cwd: release.payload,
            env: {
              ...process.env,
              AZAD_TERRAFORM_INSTALL: JSON.stringify(input),
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
  const forwarded = terraformArguments(command, forwardedRaw, files)
  const plan = command === "plan" ? planOutput(forwarded) : undefined
  // A failed plan must never leave an older plan where the apply looks.
  if (plan) rmSync(plan, { force: true })
  const phase = changingPhase(command, forwardedRaw)
  if (!phase || !app) {
    process.exitCode = terraform([command, ...forwarded]).status
    return
  }
  process.exitCode = withOperation(
    app,
    phase,
    { takeOver: options["take-over"] },
    (lease) => {
      checkState()
      if (own && runs)
        beginOwnWrite(files, own, runs, leaseSchema.parse(JSON.parse(lease)).id)
      const status = terraform([command, ...forwarded]).status
      // Recorded even after a failure: a failed apply keeps what it created.
      if (own && runs) finishOwnWrite(files, runs)
      // The deployment object tells release updates what this infrastructure
      // provides; it is written after every successful apply.
      if (
        status === 0 &&
        command === "apply" &&
        terraformOutputs(terraform).deploy
      )
        app.publish(lease, JSON.stringify(handoff(lease)), REPOSITORY)
      return status
    }
  )
}

const outputsSchema = z.record(z.string(), z.looseObject({ value: z.json() }))

/** The root's outputs the deploy uses: its handoff and, for Cloud SQL, the database URL. */
function terraformOutputs(terraform: TerraformRun) {
  const result = terraform(["output", "-json"], { capture: true })
  if (result.status !== 0)
    throw new SetupError(
      "Terraform could not read this installation's outputs."
    )
  const outputs = outputsSchema.parse(JSON.parse(result.stdout || "{}"))
  const deploy = z
    .record(z.string(), z.json())
    .nullish()
    .parse(outputs.deploy?.value)
  const databaseUrl = z.string().nullish().parse(outputs.database_url?.value)
  const miniapps = z
    .looseObject({ domain: z.string() })
    .nullish()
    .parse(outputs.miniapps?.value)
  return {
    deploy,
    database_url: databaseUrl ?? undefined,
    miniapps: miniapps ?? undefined,
  }
}

/**
 * The Mini Apps domain Terraform serves (TF_VAR_miniapp_base_domain): the
 * .env's AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN while AZAD_SELF_HOST_MINIAPPS is
 * loader, empty otherwise.
 */
export function loaderDomain(env: Record<string, string>): string {
  if (env.AZAD_SELF_HOST_MINIAPPS?.trim() !== "loader") return ""
  return (env.AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
}

/**
 * Refuses a deploy from another release than the one the variables record:
 * `refresh` moves the installation to a release, and `deploy` installs it.
 *
 * @throws SetupError naming both revisions and the refresh command.
 */
export function assertDeploys(
  release: Release,
  revision: string,
  refresh: string
): void {
  if (release.revision !== revision)
    throw new SetupError(
      `${release.path} is release ${release.version} (${release.revision}), but this installation's deployment.revision is ${revision}. To deploy this release, run first:\n  ${refresh} --release ${release.path}`
    )
}

/** A lease the release's install-store.js printed. */
const leaseSchema = z.object({ id: z.string(), version: z.string() })

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof SetupError || error instanceof InstanceError || error instanceof ReleaseError ? error.message : "Cloudflare setup failed. Check input files, credential formats and external metadata; no credential values are logged."}\n`
    )
    process.exitCode = 1
  }
}
