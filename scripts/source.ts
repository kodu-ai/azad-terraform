/**
 * The unpacked Azad release a driver deploys from: a directory with
 *
 *   release.json      {"format": 1, "version", "sourceSha", "signed", "agentConnect"}
 *   payload/          the release's updater payload, with the installer
 *                     entrypoints in payload/installer/
 *   web/              the portable web build
 *
 * The `azad` CLI downloads a release and checks its signature; by hand you
 * point `--release` at one you unpacked. This repository holds no app
 * knowledge. Everything specific to the app (validating and deriving its
 * settings, installing, uninstalling, migrating, verifying) runs as a
 * subprocess of a stable entrypoint in that release, from its payload:
 *
 *   cd <release>/payload && bun --no-env-file installer/<entry>.js …
 *
 * The drivers call `settings.js` during setup, `cloudflare-install.js
 * install` and `celld-install.js` in their `deploy` (with the handoff
 * Terraform outputs), and `install-store.js` around every command that
 * changes the installation (see ./state.ts). Terraform's destroy-time
 * provisioner runs `cloudflare-install.js uninstall` (modules/installation)
 * from the path the drivers pass as `release_dir`. The install entrypoints
 * find the rest of the release from their own location.
 * Settings travel on stdin as JSON, never as arguments or files. The
 * settings entrypoint exits 0 with JSON on stdout, 65 when it refuses a
 * setting (its reason on stderr) and 64 for a usage error.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { isolatedProcessEnv } from "./lib"

/** The installer entrypoints a release must contain, in `payload/installer/<name>.js`. */
export const INSTALLERS = [
  "settings",
  "cloudflare-install",
  "celld-install",
  "install-store",
] as const
export type Installer = (typeof INSTALLERS)[number]

/** A refusal whose message names paths and settings, never their values. */
export class ReleaseError extends Error {
  name = "ReleaseError"
}

/** `release.json`, format 1. */
const releaseSchema = z.object({
  format: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  signed: z.boolean(),
  agentConnect: z.object({ version: z.string().min(1) }).nullable(),
})

/** A validated, unpacked Azad release. */
export type Release = {
  /** Absolute path of the release directory. */
  path: string
  /** `<path>/payload`: where every installer entrypoint runs. */
  payload: string
  /** The release version (`deployment.version`). */
  version: string
  /** The app commit it was built from, which deploys bind to (`deployment.revision`). */
  revision: string
}

const MISSING = `Name the unpacked Azad release (the azad CLI downloads and verifies one) with --release <dir> or AZAD_RELEASE.`

/** `--release`, else `AZAD_RELEASE`; undefined when neither is set. */
export function releaseOption(
  option: string | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return option?.trim() || env.AZAD_RELEASE?.trim() || undefined
}

/** The absolute path of one installer entrypoint of `release`. */
export function installer(release: Release, name: Installer): string {
  return join(release.payload, "installer", `${name}.js`)
}

/**
 * Validates the release `option` (or `AZAD_RELEASE`) names: a directory
 * whose `release.json` this version reads, with the four installer
 * entrypoints in `payload/installer/`.
 *
 * @throws ReleaseError naming what is missing.
 */
export function requireRelease(
  option: string | undefined,
  env: Record<string, string | undefined> = process.env
): Release {
  const selected = releaseOption(option, env)
  if (!selected) throw new ReleaseError(`--release is required. ${MISSING}`)
  const path = resolve(selected)
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new ReleaseError(`${path} does not exist. ${MISSING}`)
  const manifest = join(path, "release.json")
  if (!existsSync(manifest))
    throw new ReleaseError(
      `${path} is not an Azad release: it has no release.json. ${MISSING}`
    )
  let text: unknown
  try {
    text = JSON.parse(readFileSync(manifest, "utf8"))
  } catch {
    text = undefined
  }
  const parsed = releaseSchema.safeParse(text)
  if (!parsed.success)
    throw new ReleaseError(
      `${manifest} is not a release manifest this version reads: it needs format 1, version, sourceSha, signed and agentConnect.`
    )
  const release: Release = {
    path,
    payload: join(path, "payload"),
    version: parsed.data.version,
    revision: parsed.data.sourceSha,
  }
  const missing = INSTALLERS.filter(
    (name) => !existsSync(installer(release, name))
  ).map((name) => `payload/installer/${name}.js`)
  if (missing.length)
    throw new ReleaseError(
      `${path} is not an Azad release this version supports: it lacks ${missing.join(", ")}. Use a release with the installer entrypoints.`
    )
  return release
}

/** Non-secret object storage the app selected from the STORAGE_* settings. */
export type StorageSelection =
  | { kind: "r2" }
  | {
      kind: "s3" | "gcs"
      bucket: string
      releasesBucket: string
      endpoint?: string
      region?: string
    }

/**
 * What setup asks the app about its settings. Production runs the release's
 * `payload/installer/settings.js`; tests pass plain functions.
 */
export type AppSettings = {
  /** Prefix of the Cloudflare resource names the installer derives from the API origin. */
  resourcePrefix(apiOrigin: string): string
  /** The object storage the STORAGE_* settings select. */
  storage(settings: Record<string, string>): StorageSelection
  /**
   * Checks the settings a Cloudflare installation (`cloudflare`) or a celld
   * installation on Google Cloud (`celld`) deploys with.
   */
  validate(
    target: "cloudflare" | "celld",
    settings: Record<string, string>
  ): void
}

/** A setting the app refused; the message names the setting, never its value. */
export class SettingsRefused extends Error {
  name = "SettingsRefused"
}

const storageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("r2") }),
  z.object({
    kind: z.enum(["s3", "gcs"]),
    bucket: z.string().min(1),
    releasesBucket: z.string().min(1),
    endpoint: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    region: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
  }),
])

/** The settings entrypoint's exit status for refused settings (sysexits EX_DATAERR). */
const EXIT_REFUSED = 65

/**
 * Runs the release's `settings.js` in its payload. Exit 0 returns stdout;
 * exit 65 is a refused setting (SettingsRefused with the entrypoint's
 * message, which names the setting, never its value); anything else is a
 * broken release (ReleaseError).
 */
function settingsEntry(
  release: Release,
  args: string[],
  input?: Record<string, string>
): string {
  const entry = installer(release, "settings")
  const result = Bun.spawnSync(
    [process.execPath, "--no-env-file", entry, ...args],
    {
      cwd: release.payload,
      env: isolatedProcessEnv(),
      stdin:
        input === undefined
          ? "ignore"
          : new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const message = result.stderr.toString().trim().slice(-2000)
  if (result.exitCode === 0) return result.stdout.toString()
  if (result.exitCode === EXIT_REFUSED)
    throw new SettingsRefused(message || "The app refused these settings.")
  throw new ReleaseError(
    `${entry} ${args[0]} failed (exit ${result.exitCode})${message ? `:\n${message}` : "."}`
  )
}

/** JSON from the entrypoint's stdout; undefined when it is not JSON. */
function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** {@link AppSettings} answered by the release's own entrypoint. */
export function sourceSettings(release: Release): AppSettings {
  return {
    resourcePrefix(apiOrigin) {
      const output = settingsEntry(release, [
        "resource-names",
        "--api-origin",
        apiOrigin,
      ])
      const parsed = z
        .object({ prefix: z.string().regex(/^[a-z0-9-]+$/u) })
        .safeParse(json(output))
      if (!parsed.success)
        throw new ReleaseError(
          "The release's settings entrypoint returned unexpected resource names."
        )
      return parsed.data.prefix
    },
    storage(settings) {
      const parsed = storageSchema.safeParse(
        json(settingsEntry(release, ["storage"], settings))
      )
      if (!parsed.success)
        throw new ReleaseError(
          "The release's settings entrypoint returned an unexpected storage selection."
        )
      return parsed.data
    },
    validate(target, settings) {
      settingsEntry(release, ["validate", target], settings)
    },
  }
}
