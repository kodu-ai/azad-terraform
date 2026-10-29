/**
 * Small process and file helpers the drivers share. They hold no Azad app
 * knowledge; that stays in the app's own `scripts/self-host` entrypoints
 * (see ./source.ts).
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parse } from "dotenv"

/** The part of `fetch` the drivers call; tests pass plain functions. */
export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

/** A JSON value as `JSON.stringify` writes it. */
export type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | Json[]
  | { [key: string]: Json }

/** Reads exactly the selected dotenv file; ambient credentials never participate. */
export function readEnvFile(path: string): Record<string, string> {
  return parse(readFileSync(path, "utf8"))
}

/** Child processes inherit only OS plumbing and explicitly selected settings. */
export function isolatedProcessEnv(
  extra: Record<string, string> = {}
): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    const value = process.env[key]
    if (value) entries.push([key, value])
  }
  return {
    ...Object.fromEntries(entries),
    AZAD_ISOLATED_ENV: "1",
    CI: "1",
    ...extra,
  }
}

/** Atomic private writes prevent torn state and avoid a world-readable interval for secrets. */
export function writePrivateJson(
  path: string,
  value: { [key: string]: Json }
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  })
  renameSync(temporary, path)
}
