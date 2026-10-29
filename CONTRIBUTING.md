# Contributing

Thanks for helping. This repository holds infrastructure only: Terraform roots
and modules, and the Bun drivers that run them. Anything that knows about the
Azad app belongs in the app's `scripts/self-host` entrypoints
([`kodu-ai/azad-ide-web`](https://github.com/kodu-ai/azad-ide-web)), which the
drivers and modules run as subprocesses; do not import app code here.

## Setup

```sh
bun install --frozen-lockfile   # Bun 1.4.4+
terraform version               # 1.13.4+
```

## Checks

CI (`.github/workflows/ci.yml`) runs exactly these on every pull request and
push to `main`; run them before opening a pull request:

| What | Command |
| --- | --- |
| Driver unit tests | `bun test scripts` |
| Types (Bun's built-in checker) | `bun run typecheck` |
| TypeScript and JSON formatting (oxfmt) | `bun run format:check`; fix with `bun run format` |
| Terraform: `fmt -check -recursive`, `init -backend=false` + `validate` for every root and module, and `terraform test` where tests exist | `scripts/check-terraform.sh` (or `scripts/check-terraform.sh roots/postgres` for one directory) |

Every check is offline with respect to your accounts: the driver tests use fake
HTTP boundaries, a stand-in `terraform` and a stand-in app checkout
(`scripts/fixtures/source.ts`); Terraform tests use mocked providers and
plan-only runs. `check-terraform.sh` keeps Terraform's working data in a
temporary directory and only downloads providers. Never point a check at a
real instance directory.

## Conventions

- **Tests.** Prove behavior at the driver's seams: `prepareCloudflare` and
  `prepareGcp` with a fake fetcher and fake `AppSettings`, the CLI through a
  spawned driver with a stand-in `terraform` on `PATH`, and Terraform through
  `tests/*.tftest.hcl` next to the root or module. Write the failing test first
  for a bug.
- **Secrets.** Credentials travel in private files and environment variables,
  never in command arguments, Terraform variables files or logs. Error messages
  name settings and paths, never values.
- **State.** Nothing an installation owns may be written into this repository.
  The drivers refuse instance paths inside it, and `.gitignore` keeps stray
  Terraform files out of Git.
- **Lock files.** Roots commit `.terraform.lock.hcl` with hashes
  for `linux_amd64`, `linux_arm64`, `darwin_amd64` and `darwin_arm64`. After
  changing a provider version, run
  `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64`
  in that directory.
- **The app contract.** The entrypoints this repository runs, and how, are
  listed in [docs/how-it-works.md](docs/how-it-works.md#the-app-contract). Changing that
  contract needs a matching change in the app repository and a minor (0.x) or
  major version.

## Releasing

1. Set `version` in `package.json` and merge it to `main`.
2. Tag that commit `v<version>` and push the tag.

`.github/workflows/release.yml` reruns every check, refuses a tag that does not
match `package.json`, builds `azad-terraform-<version>.tar.gz` and its
`.sha256` with `bun scripts/release.ts`, proves the archive installs and runs on
its own, and creates the GitHub Release with generated notes.
