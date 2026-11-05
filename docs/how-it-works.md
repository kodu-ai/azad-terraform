# How it works

This repository is infrastructure only. It holds Terraform roots and modules,
and three Bun scripts (the drivers) that run Terraform against one
installation's files. The Azad app itself lives in another repository, and
the drivers reach it only by running a few of its scripts.

## Three repositories

| Repository | What it does |
| --- | --- |
| [`kodu-ai/azad-cli`](https://github.com/kodu-ai/azad-cli) | The `azad` installer. It asks for what can't be derived (hostnames, Clerk, the GitHub App, cloud credentials), downloads a pinned release of this repository, checks its SHA-256 and runs the drivers. |
| `kodu-ai/azad-terraform` (this one) | Terraform roots and modules, and the drivers `scripts/cloudflare.ts`, `scripts/gcp.ts` and `scripts/bootstrap.ts`. No app code. |
| [`kodu-ai/azad-ide-web`](https://github.com/kodu-ai/azad-ide-web) | The Azad app. Validating settings, migrations, building and deploying, uninstalling and verifying all run from its `scripts/self-host/*` entrypoints. |

## The app contract

The drivers run the app checkout you name with `--source` (or
`AZAD_SOURCE`) as subprocesses, and never import its code:

```text
bun --no-env-file <source>/scripts/self-host/settings.ts           # setup: validates and derives settings
bun --no-env-file <source>/scripts/self-host/install-store.ts      # the installation's state in its cloud
bun --no-env-file <source>/scripts/self-host/cloudflare-install.ts # Cloudflare: deploy, and uninstall on destroy
bun --no-env-file <source>/scripts/self-host/celld-install.ts      # Google Cloud: deploy
```

- `settings.ts` takes settings as JSON on stdin, never as arguments. It exits
  0 with JSON on stdout, 65 when it refuses a setting (the reason, naming the
  setting but never its value, on stderr) and 64 for a usage error.
- `install-store.ts` takes and releases the installation's operation record
  around every command that changes it, publishes the deployment handoff
  after an apply and writes the offline key backup. Its input, in
  `AZAD_INSTALL_STATE`, names the bucket and the instance's files; no
  credential travels in it. It exits 75 when another operation holds the
  installation.
- The deploys get their input in an environment variable
  (`AZAD_TERRAFORM_INSTALL`, `AZAD_CELLD_INSTALL`): the handoff Terraform
  outputs as `deploy`, plus the revision, the database URL (Cloudflare) and
  the state bucket. They read the instance's `.env` themselves. Terraform's
  destroy runs the Cloudflare uninstall with `AZAD_TERRAFORM_UNINSTALL`.
- With `updater_image` set, the handoff also has `updater`: `{ "image" }`
  on Cloudflare, which the deploy copies into the account's container
  registry for the installation's updater Worker, and `{ "url" }` on Google
  Cloud, where the API reaches its pod's update starter. It is null
  otherwise.
- A deploy is bound to the checkout's commit. `setup` and `refresh` record its
  `HEAD` as `deployment.revision`; the deploy refuses a checkout whose `HEAD`
  differs, and one older than the revision the installation runs.

Changing this contract needs a matching change in the app and a new minor (or
major) version here.

## The drivers

| Driver | Commands |
| --- | --- |
| `scripts/cloudflare.ts` | `setup`, `refresh`, `init`, `plan`, `apply`, `deploy`, `destroy`, `backup-keys`, `output`, `validate`, `show`, `state`, `import`, `console`, `force-unlock`. `--root postgres` or `--root cloudsql` (the default). |
| `scripts/gcp.ts` | `setup`, `refresh`, `phase`, `init`, `plan`, `apply`, `deploy`, `destroy`, `backup-keys`, `output`, `show`, `state`, `force-unlock`. One root, `gcp-celld`. |
| `scripts/bootstrap.ts` | `plan`, `apply`: mints an installation's scoped Cloudflare tokens ([token-bootstrap.md](token-bootstrap.md)). |

`--help` prints each driver's usage. The rules they share:

- Every command names the installation with `--instance-dir`.
- `--root` takes a root name, never a path, so one root's state can't be
  planned with another root's configuration.
- `setup`, `refresh`, `plan`, `apply`, `deploy`, `destroy`, `backup-keys`,
  `import` and the `state` commands that write need the app checkout
  (`--source` or `AZAD_SOURCE`); the drivers check it before reading anything
  from the network. Commands that only read state don't.
- `init` comes first, and again after the instance directory or this
  repository moves, or `CLOUDFLARE_API_TOKEN` changes. The other commands
  refuse to run until it has.
- Terraform never deploys the app. `apply` changes infrastructure; `deploy`
  runs the app's installer with the handoff Terraform outputs.
- `apply`, `destroy`, `import`, the `state` commands that write and `deploy`
  hold the installation's operation record while they run (see
  [The state bucket](#the-state-bucket)).
- Anything the driver doesn't own goes to Terraform. A relative plan name
  (`-out=NAME`, `apply NAME`, `show NAME`) is a file in the instance's
  Terraform directory. A plan that fails deletes the old plan file first, so
  `apply` can never pick up a stale one.
- Nothing runs by default. `apply` without a saved plan still asks
  Terraform's confirmation.
- Credentials travel in private files and environment variables, never as
  command arguments, and error messages name settings, not their values.

On Google Cloud, everything but the cluster is planned against the cluster's
API, so a first install plans twice: the cluster and Clerk's DNS records
first, then everything else. `gcp.ts phase` prints `cluster` or `full` to say
which comes next.

## The state bucket

Each installation keeps its state in a private bucket of its own cloud,
created by `init` (see `scripts/state.ts`):

| Target | Bucket | Terraform's state | Keys |
| --- | --- | --- | --- |
| Cloudflare | R2 `<resource prefix>-install` | `terraform/<root>.tfstate`, through R2's S3 API with a lock object written create-only | The account's Secrets Store |
| Google Cloud | GCS `<name>-<project hash>-install`, versioned | `terraform/gcp-celld/`, with GCS's own lock | The project's Secret Manager |

R2's S3 credentials come from the deployment token (its id, and the SHA-256
of its value); Google's are your Application Default Credentials. The app's
install state sits beside Terraform's under `install/`: the deployment
handoff, the receipt of the release that runs, the Agent Connect source
manifest and the operation record. The deploy writes the original keys there
create-only, so nothing ever replaces them, and refills a missing local copy
where the store can give it back (Secret Manager; the Secrets Store only to
the installation's own Worker). `backup-keys --out DIR` writes an offline
copy.

The operation record makes the installation change one way at a time:
Terraform runs, deploys and (from the console) release updates. It is taken
with a conditional write and never taken over because it looks old: a record
another run holds needs `--take-over <operation id>`, once you have confirmed
that run and everything it started have stopped. The deploy checks its lease
before each change and before it records anything, so a run that was taken
over stops. A failed run leaves the record stopped and the next run resumes
it; a failed deploy keeps its revision there, so only that revision or a
later one finishes it.

## The instance directory

Each installation owns one directory, outside this repository:

```text
~/.azad/instances/<name>/
  .env                          private settings and credentials (mode 0600)
  terraform/<root>/             postgres, cloudsql or gcp-celld
    terraform.tfvars.json       what setup wrote; edit it to change settings
    backend.tfbackend           the state bucket, and backend.json, its record
    *.tfplan                    saved plans
    .terraform/                 Terraform's working data (TF_DATA_DIR)
    installer-state/            Cloudflare: the deploy's cache of keys and receipt
    celld-install/              Google Cloud: the same, plus tools and install.log
    backend_override.tf         optional: the installation's own backend (you write it)
    own-backend/, .terraform-own/   with it: the root's copy and working data
    bucket-state/               with it: a backend-only configuration for the bucket
```

Each root declares `backend "s3" {}` (Cloudflare) or `backend "gcs" {}`
(Google Cloud). The drivers' `init` points it at the installation's bucket
(`-reconfigure`) and sets `TF_DATA_DIR`. Plain `terraform` commands in a root
see none of this: use the drivers.

Releases before 0.1.0 used a local backend in this directory. `init` moves
such a state into the bucket: it pushes the file, reads it back and compares
its resources and outputs, and only then renames it to
`terraform.tfstate.before-remote-<time>`. A bucket that already holds a
different state is never written.

### An own backend

A `backend_override.tf` in the root's directory replaces the root's backend
block with any other backend or a `cloud` block (see `scripts/own-backend.ts`).
Terraform reads override files only beside the root, and the release
directory is shared by every installation on the machine, so the drivers copy
this release's `roots/<root>` and `modules` to `own-backend/` with the file,
again whenever either changes, and run Terraform there with `.terraform-own/`
as its working data. They pass that backend no R2 credentials and add no
`-backend-config` or `-reconfigure` to its `init`, so your own init arguments
(`-migrate-state`, partial configuration) reach it unchanged.

`init` then holds the operation record while it makes the bucket point there.
`bucket-state/` reads and writes the bucket's state without the root's
providers. When the own backend holds no state, `init` pushes the bucket's
(or a local state of a release before 0.1.0), reads it back and compares
resources and outputs, keeps a copy as
`terraform.tfstate.before-own-backend-<time>`, and only then replaces the
bucket's state with a pointer: no resources, and one output,
`azad_state_moved`, naming the backend type and the lineage of the state it
holds. A backend that already holds the same resources and outputs is
recorded as it is. One holding a different state is refused, and nothing is
written.

From then on, an own backend is accepted only while its state has the
recorded lineage (Terraform's `init -migrate-state` keeps it), and every
command against the bucket refuses to run, except `state push`, which brings
a state back.

The deploy's directories, saved plans and `.env` hold passwords and signing
keys: keep the instance directory private.

## Roots and modules

| Path | What it is |
| --- | --- |
| [`roots/postgres`](../roots/postgres) | Azad on Cloudflare with an existing PostgreSQL database (Neon or any provider), optionally your own S3 or GCS bucket |
| [`roots/cloudsql`](../roots/cloudsql) | Azad on Cloudflare with a new Cloud SQL database in your Google Cloud project |
| [`roots/gcp-celld`](../roots/gcp-celld) | Azad on Google Cloud: GKE Autopilot, Cloud SQL, Forgejo and a regional load balancer |
| [`roots/bootstrap`](../roots/bootstrap) | The scoped Cloudflare API tokens `scripts/bootstrap.ts` creates |
| [`modules/base`](../modules/base), [`modules/base-postgres`](../modules/base-postgres) | The two Cloudflare compositions |
| [`modules/installation`](../modules/installation) | The Cloudflare deploy handoff (`deploy` output) and the destroy-time uninstall through the app's `cloudflare-install.ts` |
| [`modules/cloudflare/*`](../modules/cloudflare) | R2 buckets and queue, Clerk DNS, DNS records, the proxied edge, hostname route reservations |
| [`modules/gcp/*`](../modules/gcp) | Cloud SQL, GKE Autopilot, the Gateway, certificates, Backup for GKE, the Cloud SQL Proxy Operator, the agent machine, the console updater's identity and access (`modules/gcp/updater`) |
| [`modules/kubernetes/*`](../modules/kubernetes) | cert-manager, Forgejo, raw manifests |
| [`modules/celld/*`](../modules/celld) | The celld fleet (a StatefulSet with PgBouncer) and the deploy handoff (`deploy` output) for the app's `celld-install.ts` |
| [`modules/clerk/application`](../modules/clerk/application) | Deletes an evaluation install's Clerk application on destroy |

Only official providers are used: `hashicorp/google`, `hashicorp/random`,
`hashicorp/kubernetes`, `hashicorp/helm`, `hashicorp/http`, `hashicorp/tls`
and `cloudflare/cloudflare`. Each root commits its provider lock file.
