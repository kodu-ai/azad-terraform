/**
 * The Azad app source checkout (`kodu-ai/azad-ide-web`) a driver deploys from.
 *
 * This repository holds no app knowledge. Everything specific to the app
 * (validating and deriving its settings, installing, uninstalling, migrating,
 * verifying) runs as a subprocess of a stable entrypoint in that checkout:
 *
 *   bun --no-env-file <source>/scripts/self-host/<entry>.ts …
 *
 * The drivers call `settings.ts` during setup; Terraform's provisioners run
 * `cloudflare-install.ts` (modules/installation) and `celld-install.ts`
 * (modules/celld/app) with the path the drivers pass as `source_dir`.
 * Settings travel on stdin as JSON, never as arguments or files. The
 * settings entrypoint exits 0 with JSON on stdout, 65 when it refuses a
 * setting (its reason on stderr) and 64 for a usage error.
 */
import { existsSync, realpathSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { isolatedProcessEnv } from "./lib"

/** The app entrypoints a source checkout must contain. */
export const ENTRYPOINTS = [
  "scripts/self-host/settings.ts",
  "scripts/self-host/cloudflare-install.ts",
  "scripts/self-host/celld-install.ts",
] as const

/** A refusal whose message names paths and settings, never their values. */
export class SourceError extends Error {
  name = "SourceError"
}

/** A validated app source checkout. */
export type Source = {
  /** Absolute path of the checkout's top level. */
  path: string
  /** Its HEAD commit, which deploys bind to (`deployment.revision`). */
  revision: string
}

const MISSING = `Name the Azad app source checkout (a Git clone of kodu-ai/azad-ide-web with its dependencies installed) with --source <path> or AZAD_SOURCE.`

/** `--source`, else `AZAD_SOURCE`; undefined when neither is set. */
export function sourceOption(
  option: string | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return option?.trim() || env.AZAD_SOURCE?.trim() || undefined
}

function git(path: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", path, ...args], {
    env: isolatedProcessEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

/**
 * Validates the checkout `option` (or `AZAD_SOURCE`) names: the top level of
 * a Git checkout with a readable HEAD, the app's self-host entrypoints and
 * installed dependencies.
 *
 * @throws SourceError naming what is missing.
 */
export function requireSource(
  option: string | undefined,
  env: Record<string, string | undefined> = process.env
): Source {
  const selected = sourceOption(option, env)
  if (!selected) throw new SourceError(`--source is required. ${MISSING}`)
  const path = resolve(selected)
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new SourceError(`${path} does not exist. ${MISSING}`)
  const top = git(path, ["rev-parse", "--show-toplevel"])
  if (!top) throw new SourceError(`${path} is not a Git checkout. ${MISSING}`)
  if (realpathSync(top) !== realpathSync(path))
    throw new SourceError(
      `${path} is inside the Git checkout ${top}; pass the checkout's top-level directory.`
    )
  const revision = git(path, ["rev-parse", "HEAD"])
  if (!revision || !/^[a-f0-9]{40}$/u.test(revision))
    throw new SourceError(`${path} has no readable HEAD commit.`)
  const missing = ENTRYPOINTS.filter((entry) => !existsSync(join(path, entry)))
  if (missing.length)
    throw new SourceError(
      `${path} is not an Azad app source checkout this release supports: it lacks ${missing.join(", ")}. Use a kodu-ai/azad-ide-web revision with the scripts/self-host entrypoints.`
    )
  if (!existsSync(join(path, "node_modules")))
    throw new SourceError(
      `${path} has no installed dependencies. Run: bun install --frozen-lockfile --cwd ${path}`
    )
  return { path, revision }
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
 * What setup asks the app about its settings. Production runs the source's
 * `scripts/self-host/settings.ts`; tests pass plain functions.
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
 * Runs `scripts/self-host/settings.ts` in `source`. Exit 0 returns stdout;
 * exit 65 is a refused setting (SettingsRefused with the entrypoint's
 * message, which names the setting, never its value); anything else is a
 * broken checkout (SourceError).
 */
function settingsEntry(
  source: string,
  args: string[],
  input?: Record<string, string>
): string {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      join(source, "scripts/self-host/settings.ts"),
      ...args,
    ],
    {
      cwd: source,
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
  throw new SourceError(
    `${join(source, "scripts/self-host/settings.ts")} ${args[0]} failed (exit ${result.exitCode})${message ? `:\n${message}` : "."}`
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

/** {@link AppSettings} answered by the source checkout's own entrypoint. */
export function sourceSettings(source: Source): AppSettings {
  return {
    resourcePrefix(apiOrigin) {
      const output = settingsEntry(source.path, [
        "resource-names",
        "--api-origin",
        apiOrigin,
      ])
      const parsed = z
        .object({ prefix: z.string().regex(/^[a-z0-9-]+$/u) })
        .safeParse(json(output))
      if (!parsed.success)
        throw new SourceError(
          "The source's settings entrypoint returned unexpected resource names."
        )
      return parsed.data.prefix
    },
    storage(settings) {
      const parsed = storageSchema.safeParse(
        json(settingsEntry(source.path, ["storage"], settings))
      )
      if (!parsed.success)
        throw new SourceError(
          "The source's settings entrypoint returned an unexpected storage selection."
        )
      return parsed.data
    },
    validate(target, settings) {
      settingsEntry(source.path, ["validate", target], settings)
    },
  }
}
