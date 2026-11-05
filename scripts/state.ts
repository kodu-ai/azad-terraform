/**
 * Each installation keeps its state in its own cloud, in one bucket the
 * drivers create before the first `init`:
 *
 *   Cloudflare roots   R2 bucket `<resource prefix>-install` in the account
 *   gcp-celld          GCS bucket `<name>-<project hash>-install` in the project
 *
 *   terraform/<root>.tfstate (R2) or terraform/<root>/default.tfstate (GCS)
 *                      Terraform's state, locked by Terraform itself (GCS's
 *                      native lock; on R2 a lock object written create-only)
 *   install/*.json     the app's install state: the deployment handoff, the
 *                      receipt of what runs, the Agent Connect source manifest
 *                      and the install-wide operation record
 *
 * The keys live in the cloud's secret store (Secret Manager, or the
 * account's Secrets Store), written by the app's deploy. The instance
 * directory keeps only a cache: settings, variables, saved plans and the
 * deploy's state directory.
 *
 * Every command that changes the installation (apply, destroy, import, the
 * state commands that write, deploy, and init when it moves a local state)
 * holds the install-wide operation record while it runs, through the app
 * checkout's `scripts/self-host/install-store.ts`, so it never overlaps a
 * release update from the console or another machine. A record another run
 * holds is taken over only with `--take-over <operation id>`, once the
 * operator confirmed that run and every process it started have stopped.
 */
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { InstanceError, writePrivate, type InstanceTerraform } from "./instance"
import { isolatedProcessEnv, type Fetcher } from "./lib"
import type { Source } from "./source"

/** Where an installation's state lives, as the app's install store names it. */
export type InstallStore =
  | { kind: "gcs"; bucket: string; project_id: string }
  | { kind: "r2"; bucket: string; account_id: string }

const storeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("gcs"),
    bucket: z.string(),
    project_id: z.string(),
  }),
  z.strictObject({
    kind: z.literal("r2"),
    bucket: z.string(),
    account_id: z.string().regex(/^[a-f0-9]{32}$/u),
  }),
])

/**
 * What this release's roots provide to a release (see the app's
 * `infrastructureSchema`): raise `revision` whenever a root gains a resource
 * a release may need, and name optional resources in `capabilities`.
 */
export const INFRASTRUCTURE = { revision: 1, capabilities: [] as string[] }

/** This release's version, recorded with the deployment it wrote. */
export function terraformVersion(repository: string): string {
  return z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(repository, "package.json"), "utf8")))
    .version
}

/**
 * The Cloudflare resource prefix the app derives from the API origin (its
 * `resourceNames`, modules/cloudflare/resources): `azad-<host slug>` cut to
 * 30 characters, then 8 hex digits of the origin's SHA-256.
 */
export function cloudflarePrefix(apiOrigin: string): string {
  const slug = apiOrigin
    .replace(/^https:\/\//u, "")
    .replaceAll(/[^a-z0-9]+/gu, "-")
  const hash = createHash("sha256").update(apiOrigin).digest("hex").slice(0, 8)
  return `${`azad-${slug}`.slice(0, 30).replace(/-+$/u, "")}-${hash}`
}

/** The R2 bucket of a Cloudflare installation. */
export function cloudflareStore(
  accountId: string,
  apiOrigin: string
): InstallStore {
  return {
    kind: "r2",
    bucket: `${cloudflarePrefix(apiOrigin)}-install`,
    account_id: accountId,
  }
}

/** The GCS bucket of a Google Cloud installation; bucket names are global, so the project is part of it. */
export function gcpStore(name: string, projectId: string): InstallStore {
  const hash = createHash("sha256").update(projectId).digest("hex").slice(0, 8)
  return {
    kind: "gcs",
    bucket: `${name}-${hash}-install`,
    project_id: projectId,
  }
}

/** The backend configuration `init` passes for root `files.name`. */
export function backendConfig(store: InstallStore, root: string): string {
  if (store.kind === "gcs")
    return `bucket = "${store.bucket}"\nprefix = "terraform/${root}"\n`
  return [
    `bucket = "${store.bucket}"`,
    `key = "terraform/${root}.tfstate"`,
    `region = "auto"`,
    `endpoints = { s3 = "https://${store.account_id}.r2.cloudflarestorage.com" }`,
    // R2 commits a create-only PutObject atomically, so this lock holds.
    `use_lockfile = true`,
    `use_path_style = true`,
    `skip_credentials_validation = true`,
    `skip_region_validation = true`,
    `skip_requesting_account_id = true`,
    `skip_metadata_api_check = true`,
    "",
  ].join("\n")
}

/** What `init` records beside the backend configuration: the store and, for R2, the token's id. */
const recordSchema = z.strictObject({
  store: storeSchema,
  /** R2's access key id is the Cloudflare token's id; its secret is the token's SHA-256. */
  token: z.strictObject({ id: z.string(), digest: z.string() }).optional(),
})
export type BackendRecord = z.infer<typeof recordSchema>

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex")

/** `<directory>/backend.json`, written by `init`. */
export function readBackendRecord(files: InstanceTerraform, init: string) {
  if (!existsSync(files.backendRecord))
    throw new InstanceError(
      `${files.directory} has no state bucket configured yet. Run:\n  ${init}`
    )
  return recordSchema.parse(
    JSON.parse(readFileSync(files.backendRecord, "utf8"))
  )
}

/**
 * Credentials Terraform's backend reads from the environment: R2's S3 keys
 * derived from CLOUDFLARE_API_TOKEN; none for GCS, which uses Application
 * Default Credentials.
 *
 * @throws InstanceError When the token changed since `init` recorded its id.
 */
export function backendEnvironment(
  record: BackendRecord,
  token: string,
  init: string
): Record<string, string> {
  if (record.store.kind === "gcs") return {}
  if (record.token?.digest !== digest(token))
    throw new InstanceError(
      `CLOUDFLARE_API_TOKEN changed since the state bucket was configured. Run:\n  ${init}`
    )
  return {
    AWS_ACCESS_KEY_ID: record.token.id,
    AWS_SECRET_ACCESS_KEY: digest(token),
  }
}

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"

async function cloudflare(
  fetcher: Fetcher,
  token: string,
  path: string,
  init: { method?: string; body?: string } = {}
) {
  let response: Response | undefined
  for (let attempt = 1; !response; attempt++) {
    try {
      response = await fetcher(`${CLOUDFLARE_API}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      if (attempt >= 3)
        throw new InstanceError(
          "Could not reach api.cloudflare.com to configure the state bucket. Check network and proxy settings, then retry."
        )
      await Bun.sleep(1000 * attempt)
    }
  }
  const body = z
    .object({
      success: z.boolean(),
      errors: z.array(z.object({ code: z.number() })).default([]),
      result: z.unknown().optional(),
    })
    .safeParse(await response.json().catch(() => undefined))
  return { status: response.status, body: body.success ? body.data : undefined }
}

/** The id of a Cloudflare API token: account tokens verify under the account, user tokens under the user. */
async function tokenId(fetcher: Fetcher, accountId: string, token: string) {
  for (const path of [
    `/accounts/${accountId}/tokens/verify`,
    "/user/tokens/verify",
  ]) {
    const { body } = await cloudflare(fetcher, token, path)
    const id = z.object({ id: z.string() }).safeParse(body?.result)
    if (body?.success && id.success) return id.data.id
  }
  throw new InstanceError(
    "Cloudflare did not verify CLOUDFLARE_API_TOKEN; its R2 credentials for the state bucket are unknown."
  )
}

/** Creates the R2 bucket unless this account already owns it (code 10004); retries Cloudflare's transient 10001. */
async function ensureR2Bucket(
  fetcher: Fetcher,
  store: Extract<InstallStore, { kind: "r2" }>,
  token: string
) {
  for (let attempt = 1; ; attempt++) {
    const { status, body } = await cloudflare(
      fetcher,
      token,
      `/accounts/${store.account_id}/r2/buckets`,
      { method: "POST", body: JSON.stringify({ name: store.bucket }) }
    )
    const codes = body?.errors.map((error) => error.code) ?? []
    if (body?.success || codes.includes(10004)) return
    if (codes.includes(10001) && attempt < 4) {
      await Bun.sleep(2000 * attempt)
      continue
    }
    throw new InstanceError(
      status === 403
        ? `CLOUDFLARE_API_TOKEN may not create the R2 bucket ${store.bucket}: it needs Workers R2 Storage Edit on the account.`
        : `Cloudflare refused to create the R2 bucket ${store.bucket} (HTTP ${status}${codes.length ? `, code ${codes.join(", ")}` : ""}).`
    )
  }
}

/** Application Default Credentials through `gcloud`, as Terraform's Google backend uses them. */
export function gcloudToken(): string {
  const result = Bun.spawnSync(
    ["gcloud", "auth", "application-default", "print-access-token"],
    {
      env: {
        ...isolatedProcessEnv(),
        ...Object.fromEntries(
          ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG"].flatMap(
            (key) => (process.env[key] ? [[key, process.env[key] ?? ""]] : [])
          )
        ),
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const token = result.stdout.toString().trim()
  if (result.exitCode !== 0 || !token)
    throw new InstanceError(
      "gcloud could not print an Application Default Credentials token. Run gcloud auth application-default login, then retry."
    )
  return token
}

/**
 * Creates the GCS bucket in the installation's region, private (uniform
 * access, public access prevented) and versioned, so earlier states can be
 * restored; keeps the newest 50 versions of each object. A bucket that
 * already exists must be readable with these credentials, or its name
 * belongs to someone else.
 */
async function ensureGcsBucket(
  fetcher: Fetcher,
  store: Extract<InstallStore, { kind: "gcs" }>,
  location: string,
  token: string
) {
  const request = async (
    url: string,
    init: { method?: string; body?: string } = {}
  ) => {
    try {
      return await fetcher(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new InstanceError(
        "Could not reach storage.googleapis.com to configure the state bucket. Check network and proxy settings, then retry."
      )
    }
  }
  const created = await request(
    `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(store.project_id)}`,
    {
      method: "POST",
      body: JSON.stringify({
        name: store.bucket,
        location,
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: true },
          publicAccessPrevention: "enforced",
        },
        versioning: { enabled: true },
        lifecycle: {
          rule: [
            {
              action: { type: "Delete" },
              condition: { numNewerVersions: 50, isLive: false },
            },
          ],
        },
        labels: { "azad-install": "state" },
      }),
    }
  )
  if (created.ok) return
  if (created.status === 409) {
    const existing = await request(
      `https://storage.googleapis.com/storage/v1/b/${store.bucket}`
    )
    if (existing.ok) return
    throw new InstanceError(
      `The state bucket name ${store.bucket} is taken by another project.`
    )
  }
  throw new InstanceError(
    created.status === 403
      ? `Your Google credentials may not create the bucket ${store.bucket} in ${store.project_id}: they need Storage Admin (or Owner).`
      : `Google refused to create the state bucket ${store.bucket} (HTTP ${created.status}). Check that the Cloud Storage API is enabled in ${store.project_id}.`
  )
}

/**
 * Creates the installation's bucket if needed and writes what every later
 * command reads: the backend configuration and its record (`backend.json`).
 */
export async function configureBackend(
  files: InstanceTerraform,
  store: InstallStore,
  options: {
    /** CLOUDFLARE_API_TOKEN: R2's credentials, and the token R2 buckets are created with. */
    token: string
    /** The GCS bucket's location: the installation's region. */
    location?: string
    fetcher?: Fetcher
    googleToken?: () => string
  }
): Promise<BackendRecord> {
  const fetcher = options.fetcher ?? fetch
  let record: BackendRecord
  if (store.kind === "r2") {
    await ensureR2Bucket(fetcher, store, options.token)
    record = {
      store,
      token: {
        id: await tokenId(fetcher, store.account_id, options.token),
        digest: digest(options.token),
      },
    }
  } else {
    await ensureGcsBucket(
      fetcher,
      store,
      options.location ?? "US",
      (options.googleToken ?? gcloudToken)()
    )
    record = { store }
  }
  writePrivate(files.backend, backendConfig(store, files.name))
  writePrivate(files.backendRecord, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** The parts of a Terraform state the drivers compare. */
export const localStateSchema = z.looseObject({
  lineage: z.string(),
  resources: z.array(z.json()).default([]),
  outputs: z.record(z.string(), z.json()).default({}),
})

/** What a state records about the installation; a move keeps it exactly (Terraform gives the moved state a new lineage). */
export const contents = (state: z.infer<typeof localStateSchema>) =>
  JSON.stringify({ resources: state.resources, outputs: state.outputs })

/**
 * The state a release before 0.1.0 kept in the instance directory, if it
 * holds anything: those releases used a local backend.
 */
export function localState(files: InstanceTerraform) {
  if (!existsSync(files.state)) return undefined
  const text = readFileSync(files.state, "utf8")
  if (!text.trim()) return undefined
  const state = localStateSchema.parse(JSON.parse(text))
  return state.resources.length ? state : undefined
}

/**
 * Refuses a command while the instance still holds the local state of a
 * release before 0.1.0: the bucket does not have it yet, so a plan would see
 * an empty installation.
 */
export function assertMoved(files: InstanceTerraform, init: string): void {
  if (localState(files))
    throw new InstanceError(
      `${files.state} still holds this installation's Terraform state from a release before 0.1.0; it is not in the state bucket yet. Run:\n  ${init}`
    )
}

/** Runs Terraform in the root; returns its exit status and captured stdout. */
export type TerraformRun = (
  args: string[],
  options?: { capture?: boolean }
) => { status: number; stdout: string }

/**
 * Moves the local state of an existing installation into its bucket,
 * keeping the local file: it is pushed with Terraform into the empty
 * bucket, read back and compared (its resources and outputs), and only then
 * renamed out of the way, where no release reads it as current. A bucket that already
 * holds exactly this state (an interrupted move) is accepted; one that holds
 * any other state is never written. Run after `init` configured the remote
 * backend, holding the installation's operation record; until the local
 * file is renamed, the drivers refuse every other command
 * ({@link assertMoved}).
 *
 * @returns The copy kept beside the instance's other files, or undefined
 *   when there was nothing to move.
 * @throws InstanceError When the bucket holds a different state; the local
 *   state is left as it was.
 */
export function moveLocalState(
  files: InstanceTerraform,
  terraform: TerraformRun,
  now = new Date()
): string | undefined {
  const local = localState(files)
  if (!local) return undefined
  const kept = `${files.state}.before-remote-${now.toISOString().replaceAll(/[:.]/gu, "-")}`
  const pull = () => {
    const pulled = terraform(["state", "pull"], { capture: true })
    if (pulled.status !== 0)
      throw new InstanceError(
        `Terraform could not read the state bucket; the local state in ${files.state} is unchanged.`
      )
    if (!pulled.stdout.trim()) return undefined
    const state = localStateSchema.parse(JSON.parse(pulled.stdout))
    // A backend without a state answers with an empty one, which GCS also
    // gives a fresh lineage: nothing is recorded in it.
    return state.resources.length || Object.keys(state.outputs).length
      ? state
      : undefined
  }
  const remote = pull()
  if (remote && contents(remote) !== contents(local))
    throw new InstanceError(
      `The state bucket already holds a different state. Nothing was moved; the local state in ${files.state} is unchanged.`
    )
  // -force: the empty state Terraform created there has another lineage.
  // The caller holds the installation's operation record, so nothing else
  // writes the bucket's state meanwhile.
  if (
    !remote &&
    terraform(["state", "push", "-force", files.state]).status !== 0
  )
    throw new InstanceError(
      `Terraform did not move the local state into the bucket; ${files.state} is unchanged.`
    )
  const moved = pull()
  if (!moved || contents(moved) !== contents(local))
    throw new InstanceError(
      `The state read back from the bucket differs from ${files.state}, which is unchanged. Inspect the bucket before you retry.`
    )
  renameSync(files.state, kept)
  if (existsSync(`${files.state}.backup`))
    renameSync(`${files.state}.backup`, `${kept}.previous`)
  return kept
}

/** The app checkout's state entrypoint with this installation's handoff. */
export function installStore(
  source: Source,
  handoff: {
    store: InstallStore
    kind: "cloudflare" | "celld"
    env_file: string
    state_directory: string
  }
) {
  const entry = join(source.path, "scripts/self-host/install-store.ts")
  const run = (args: string[], stdin?: string) => {
    const result = Bun.spawnSync(
      [process.execPath, "--no-env-file", entry, ...args],
      {
        cwd: source.path,
        env: {
          ...process.env,
          AZAD_INSTALL_STATE: JSON.stringify(handoff),
        },
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const message = result.stderr.toString().trim().slice(-2000)
    if (result.exitCode !== 0)
      throw new InstanceError(
        result.exitCode === 75
          ? message
          : `The installation's state step ${args[0]} failed${message ? `: ${message}` : "."}`
      )
    return result.stdout.toString().trim()
  }
  return {
    /**
     * Takes the install-wide operation record for `phase`, journaling the
     * source revision a deploy installs; returns the lease.
     */
    acquire(phase: string, takeOver?: string, revision?: string) {
      return run([
        "acquire",
        "--phase",
        phase,
        "--executor",
        `${hostname()} pid ${process.pid}`,
        ...(revision ? ["--revision", revision] : []),
        ...(takeOver ? ["--confirm-stopped", takeOver] : []),
      ])
    },
    finish(lease: string) {
      run(["finish", "--lease", lease])
    },
    stop(lease: string, error: string) {
      run(["stop", "--lease", lease, "--error", error])
    },
    /** Records the deployment handoff, its credentials and the settings in the store. */
    publish(lease: string, deploy: string, repository: string) {
      run(
        [
          "publish",
          "--lease",
          lease,
          "--infrastructure",
          JSON.stringify(INFRASTRUCTURE),
          "--cli",
          /^\d+\.\d+\.\d+$/u.test(process.env.AZAD_CLI_VERSION ?? "")
            ? (process.env.AZAD_CLI_VERSION ?? "-")
            : "-",
          "--terraform",
          terraformVersion(repository),
        ],
        deploy
      )
    },
    backup(out: string) {
      return run(["backup", "--out", out])
    },
    /** True once a deploy has recorded the installation's receipt in its store. */
    deployed() {
      return run(["deployed"]) === "true"
    },
  }
}

/**
 * Runs `work` while holding the install-wide operation record: released as
 * finished when it returns 0, as stopped (resumable) otherwise. Ctrl-C
 * reaches the Terraform child; this process stays to release the record.
 */
export function withOperation(
  store: Pick<ReturnType<typeof installStore>, "acquire" | "finish" | "stop">,
  phase: string,
  options: { takeOver?: string; revision?: string },
  // A child stopped by a signal reports no exit status.
  work: (lease: string) => number | null
): number {
  const lease = store.acquire(phase, options.takeOver, options.revision)
  const ignore = () => {}
  process.on("SIGINT", ignore)
  process.on("SIGTERM", ignore)
  let status: number | null = 1
  try {
    status = work(lease)
  } finally {
    process.off("SIGINT", ignore)
    process.off("SIGTERM", ignore)
    if (status === 0) store.finish(lease)
    else
      store.stop(
        lease,
        status === null
          ? `${phase} was interrupted.`
          : `${phase} exited with status ${status}.`
      )
  }
  return status ?? 1
}
