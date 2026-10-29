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

The drivers and Terraform run the app checkout you name with `--source` (or
`AZAD_SOURCE`) as subprocesses, and never import its code:

```text
bun --no-env-file <source>/scripts/self-host/settings.ts           # setup: validates and derives settings
bun --no-env-file <source>/scripts/self-host/cloudflare-install.ts # Cloudflare: deploy on apply, uninstall on destroy
bun --no-env-file <source>/scripts/self-host/celld-install.ts      # Google Cloud: deploy on apply
```

- `settings.ts` takes settings as JSON on stdin, never as arguments. It exits
  0 with JSON on stdout, 65 when it refuses a setting (the reason, naming the
  setting but never its value, on stderr) and 64 for a usage error.
- The deploy steps get their input in environment variables
  (`AZAD_TERRAFORM_INSTALL`, `AZAD_TERRAFORM_UNINSTALL`, `AZAD_CELLD_INSTALL`)
  from Terraform `local-exec` provisioners, and read the instance's `.env`
  themselves.
- A deploy is bound to the checkout's commit. `setup` and `refresh` record its
  `HEAD` as `deployment.revision`, a new revision redeploys, and the deploy
  refuses a checkout whose `HEAD` differs.

Changing this contract needs a matching change in the app and a new minor (or
major) version here.

## The drivers

| Driver | Commands |
| --- | --- |
| `scripts/cloudflare.ts` | `setup`, `refresh`, `init`, `plan`, `apply`, `destroy`, `output`, `validate`, `show`, `state`, `import`, `console`. `--root postgres` or `--root cloudsql` (the default). |
| `scripts/gcp.ts` | `setup`, `refresh`, `phase`, `init`, `plan`, `apply`, `destroy`, `output`, `show`, `state`. One root, `gcp-celld`. |
| `scripts/bootstrap.ts` | `plan`, `apply`: mints an installation's scoped Cloudflare tokens ([token-bootstrap.md](token-bootstrap.md)). |

`--help` prints each driver's usage. The rules they share:

- Every command names the installation with `--instance-dir`.
- `--root` takes a root name, never a path, so one root's state can't be
  planned with another root's configuration.
- `setup`, `refresh`, `plan`, `apply` and `destroy` need the app checkout
  (`--source` or `AZAD_SOURCE`); the drivers check it before reading anything
  from the network. Commands that only read state don't.
- `init` comes first, and again after the instance directory or this
  repository moves. The other commands refuse to run until it has.
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

## The instance directory

Each installation owns one directory, outside this repository:

```text
~/.azad/instances/<name>/
  .env                          private settings and credentials (mode 0600)
  terraform/<root>/             postgres, cloudsql or gcp-celld
    terraform.tfvars.json       what setup wrote; edit it to change settings
    terraform.tfstate, .backup  the local backend's state
    *.tfplan                    saved plans
    .terraform/                 Terraform's working data (TF_DATA_DIR)
    installer-state/            Cloudflare: the app's state and keys
    celld-install/              Google Cloud: the app's keys, tools and install.log
```

Each root declares `backend "local" {}`. The drivers' `init` points it at the
instance's state (`-reconfigure`, so a moved directory never reuses an old
path) and sets `TF_DATA_DIR`. Plain `terraform` commands in a root see none of
this: use the drivers. Because the instance directory holds everything, any
copy of the same release and any checkout of the bound app revision can drive
it.

State, saved plans and the key directories hold passwords and signing keys:
back up the whole instance directory and keep it private. To keep state in a
remote backend instead, replace the root's `backend` block and run Terraform
yourself.

## Roots and modules

| Path | What it is |
| --- | --- |
| [`roots/postgres`](../roots/postgres) | Azad on Cloudflare with an existing PostgreSQL database (Neon or any provider), optionally your own S3 or GCS bucket |
| [`roots/cloudsql`](../roots/cloudsql) | Azad on Cloudflare with a new Cloud SQL database in your Google Cloud project |
| [`roots/gcp-celld`](../roots/gcp-celld) | Azad on Google Cloud: GKE Autopilot, Cloud SQL, Forgejo and a regional load balancer |
| [`roots/bootstrap`](../roots/bootstrap) | The scoped Cloudflare API tokens `scripts/bootstrap.ts` creates |
| [`modules/base`](../modules/base), [`modules/base-postgres`](../modules/base-postgres) | The two Cloudflare compositions |
| [`modules/installation`](../modules/installation) | The Cloudflare deploy and uninstall handoff to the app's `cloudflare-install.ts` |
| [`modules/cloudflare/*`](../modules/cloudflare) | R2 buckets and queue, Clerk DNS, DNS records, the proxied edge, hostname route reservations |
| [`modules/gcp/*`](../modules/gcp) | Cloud SQL, GKE Autopilot, the Gateway, certificates, Backup for GKE, the Cloud SQL Proxy Operator, the agent machine |
| [`modules/kubernetes/*`](../modules/kubernetes) | cert-manager, Forgejo, raw manifests |
| [`modules/celld/*`](../modules/celld) | The celld fleet (a StatefulSet with PgBouncer) and the deploy handoff to the app's `celld-install.ts` |
| [`modules/clerk/application`](../modules/clerk/application) | Deletes an evaluation install's Clerk application on destroy |

Only official providers are used: `hashicorp/google`, `hashicorp/random`,
`hashicorp/kubernetes`, `hashicorp/helm`, `hashicorp/http`, `hashicorp/tls`
and `cloudflare/cloudflare`. Each root commits its provider lock file.
