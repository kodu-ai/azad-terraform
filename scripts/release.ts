/**
 * Builds the release assets of the committed HEAD:
 *
 *   dist/azad-terraform-<version>.tar.gz          one top-level directory,
 *                                                  azad-terraform-<version>/,
 *                                                  holding the tracked files
 *   dist/azad-terraform-<version>.tar.gz.sha256   `sha256sum` format
 *
 * <version> is package.json's. With `--tag vX.Y.Z` (the release workflow
 * passes the pushed tag) it refuses a tag that is not `v<version>`. After
 * extracting, `bun install --frozen-lockfile` inside the directory makes the
 * drivers runnable.
 *
 * Usage: bun scripts/release.ts [--tag vX.Y.Z] [--out DIR]
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { REPOSITORY } from "./instance"

class ReleaseError extends Error {
  name = "ReleaseError"
}

/** The release version and asset names for package.json's version. */
export function releaseNames(version: string) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new ReleaseError(
      `package.json's version ${version} is not a semantic version.`
    )
  const name = `azad-terraform-${version}`
  return {
    tag: `v${version}`,
    directory: name,
    archive: `${name}.tar.gz`,
    checksum: `${name}.tar.gz.sha256`,
  }
}

/** One `sha256sum`-format line for `file`'s bytes. */
export function checksumLine(bytes: Uint8Array, file: string): string {
  return `${createHash("sha256").update(bytes).digest("hex")}  ${basename(file)}\n`
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", REPOSITORY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new ReleaseError(
      `git ${args[0]} failed: ${result.stderr.toString().trim()}`
    )
  return result.stdout.toString()
}

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      out: { type: "string", default: join(REPOSITORY, "dist") },
    },
    strict: true,
  })
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")))
  const names = releaseNames(version)
  if (values.tag !== undefined && values.tag !== names.tag)
    throw new ReleaseError(
      `Tag ${values.tag} does not match package.json's version ${version}: tag ${names.tag}, or change the version.`
    )
  if (git(["status", "--porcelain"]).trim())
    throw new ReleaseError(
      "The working tree has uncommitted changes; a release archives the committed HEAD only."
    )
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })
  const archive = join(out, names.archive)
  git([
    "archive",
    "--format=tar.gz",
    `--prefix=${names.directory}/`,
    `--output=${archive}`,
    "HEAD",
  ])
  const checksum = join(out, names.checksum)
  writeFileSync(checksum, checksumLine(readFileSync(archive), archive))
  process.stdout.write(`${archive}\n${checksum}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release build failed."}\n`
    )
    process.exitCode = 1
  }
}
