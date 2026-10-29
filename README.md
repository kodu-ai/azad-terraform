# Azad Terraform

Terraform roots, reusable modules and small Bun drivers that install a
self-hosted [Azad](https://azad.pro) in **your own** cloud accounts:

- **Azad on Cloudflare**: Workers, Pages, Durable Objects, R2 and Hyperdrive in
  your Cloudflare account, with PostgreSQL from Neon or any provider you already
  use (`postgres`), or Cloud SQL in your Google Cloud project (`cloudsql`).
- **Azad on Google Cloud**: celld fleets on GKE Autopilot, Cloud SQL, an
  in-cluster Forgejo and a regional HTTPS load balancer in your Google Cloud
  project, with Cloudflare serving DNS only (`gcp-celld`).

One `apply` provisions the infrastructure and then deploys the app. Every file
an installation owns (state, variables, saved plans, keys) lives in its
**instance directory**, outside this repository.

## How it fits together

| Repository | What it does |
| --- | --- |
| [`kodu-ai/azad-cli`](https://github.com/kodu-ai/azad-cli) | The `azad` installer. It asks for what cannot be derived (hostnames, Clerk, GitHub App, cloud credentials), downloads a release of this repository, and drives it. Most people only ever run `azad`. |
| **`kodu-ai/azad-terraform`** (this repository) | The infrastructure: Terraform roots and modules, and the drivers (`scripts/cloudflare.ts`, `scripts/gcp.ts`, `scripts/bootstrap.ts`) that run them against an instance directory. It contains no app code. |
| [`kodu-ai/azad-ide-web`](https://github.com/kodu-ai/azad-ide-web) | The Azad app. Everything app-specific (validating settings, migrations, building and deploying the bundles, uninstalling, verifying) runs from its `scripts/self-host/*` entrypoints. |

The drivers and Terraform reach the app only through a **source checkout** you
name with `--source <path>` (or `AZAD_SOURCE`), running its entrypoints as
subprocesses:

```text
bun --no-env-file <source>/scripts/self-host/settings.ts           # setup: settings validation and derivation
bun --no-env-file <source>/scripts/self-host/cloudflare-install.ts # Cloudflare deploy (apply) and uninstall (destroy)
bun --no-env-file <source>/scripts/self-host/celld-install.ts      # Google Cloud deploy (apply)
```

The deploy is bound to the checkout's commit: `setup` and `refresh` record its
`HEAD` as `deployment.revision`, a new revision redeploys, and the deploy step
refuses a checkout whose `HEAD` differs.

> **Today the app deploy needs an Azad source checkout.** The app is built from
> source on the machine that runs `apply`, so `--source` must name a Git clone
> of `kodu-ai/azad-ide-web` (which currently needs access to that repository)
> with its dependencies installed (`bun install --frozen-lockfile`). This
> changes once app release artifacts are published.

## Requirements

- [Terraform](https://developer.hashicorp.com/terraform/install) **1.13.4** or
  newer (1.x).
- [Bun](https://bun.sh) **1.4.4** or newer.
- Git, and an Azad app source checkout (see above) with its own requirements
  (Node 26.12.1+ for the web build).
- For Google Cloud (the `gcp-celld` and `cloudsql` roots): the
  [gcloud CLI](https://cloud.google.com/sdk/docs/install) and Application
  Default Credentials (`gcloud auth application-default login`).
- macOS or Linux. On Windows, use WSL with both checkouts in WSL's own file
  system.

## Get it

Use a release (what `azad` downloads):

```sh
version=0.0.1
curl -fsSLO "https://github.com/kodu-ai/azad-terraform/releases/download/v$version/azad-terraform-$version.tar.gz"
curl -fsSLO "https://github.com/kodu-ai/azad-terraform/releases/download/v$version/azad-terraform-$version.tar.gz.sha256"
sha256sum --check "azad-terraform-$version.tar.gz.sha256"   # macOS: shasum -a 256 --check
tar -xzf "azad-terraform-$version.tar.gz"
cd "azad-terraform-$version" && bun install --frozen-lockfile
```

or a Git clone (`git clone https://github.com/kodu-ai/azad-terraform && cd
azad-terraform && bun install --frozen-lockfile`). Then get the app source:

```sh
git clone https://github.com/kodu-ai/azad-ide-web ~/src/azad
bun install --frozen-lockfile --cwd ~/src/azad
```

## Run the drivers by hand

`azad` runs these for you. To run them yourself, every command names the
instance directory with `--instance-dir`, and every command that validates,
deploys or uninstalls the app names the source with `--source` (or exports
`AZAD_SOURCE`). Commands that only read Terraform state (`init`, `output`,
`show`, `state`, and `phase` on Google Cloud) need no source.

### Cloudflare with your own PostgreSQL (Neon or any provider)

```sh
export AZAD_SOURCE=~/src/azad
instance=~/.azad/instances/default
mkdir -m 700 -p "$instance"
cp credentials.env.example "$instance/.env" && chmod 600 "$instance/.env"
# Fill the seven credential fields and DATABASE_URL (direct endpoint, TLS) privately.

bun --no-env-file scripts/cloudflare.ts setup --database-provider postgres \
  --web-host board.example.com --credentials "$instance/.env" \
  --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts init  --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan  --root postgres --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/cloudflare.ts apply --root postgres --instance-dir "$instance" terraform.tfplan
```

For Cloud SQL in your Google Cloud project instead, use
`--database-provider cloudsql --project-id my-project` and `--root cloudsql`
(the default root). See [docs/cloudflare.md](docs/cloudflare.md) for storage in
your own bucket, a GitHub App that does not exist yet, Clerk's production
domain, updates, recovery and uninstalling.

### Google Cloud

```sh
export AZAD_SOURCE=~/src/azad
instance=~/.azad/instances/default
bun --no-env-file scripts/gcp.ts setup --credentials "$instance/.env" \
  --project-id my-project --region europe-west1 \
  --web-host azad.example.com --account-id <cloudflare-account-id> \
  --instance-dir "$instance" [--evaluation]
bun --no-env-file scripts/gcp.ts init  --instance-dir "$instance"
bun --no-env-file scripts/gcp.ts plan  --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" terraform.tfplan
# A first install plans twice: once more for everything after the cluster.
bun --no-env-file scripts/gcp.ts plan  --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" terraform.tfplan
```

See [docs/google-cloud.md](docs/google-cloud.md) for what gets created, the
settings you can change, updates and removal.

### Updating to a new app revision

```sh
export AZAD_SOURCE=~/src/azad
git -C "$AZAD_SOURCE" pull && bun install --frozen-lockfile --cwd "$AZAD_SOURCE"
bun --no-env-file scripts/cloudflare.ts refresh --root postgres --instance-dir "$instance"  # records the new HEAD
bun --no-env-file scripts/cloudflare.ts init    --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan    --root postgres --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/cloudflare.ts apply   --root postgres --instance-dir "$instance" terraform.tfplan
```

### Driver reference

| Driver | Commands |
| --- | --- |
| `scripts/cloudflare.ts` | `setup`, `refresh`, `init`, `plan`, `apply`, `destroy`, `output`, `validate`, `show`, `state`, `import`, `console`; `--root postgres\|cloudsql` (a root name, never a path; default `cloudsql`) |
| `scripts/gcp.ts` | `setup`, `refresh`, `phase`, `init`, `plan`, `apply`, `destroy`, `output`, `show`, `state`; `--root gcp-celld` (the default) |
| `scripts/bootstrap.ts` | `plan`, `apply`: mint an installation's scoped Cloudflare tokens from one token-creating administrator token ([docs/token-bootstrap.md](docs/token-bootstrap.md)) |

Arguments the driver does not own are passed to Terraform. A relative plan
name (`-out=NAME`, `apply NAME`, `show NAME`) is a file in the instance's root
directory. Nothing runs by default: `apply` without a saved plan still asks
Terraform's confirmation.

## The instance directory and state

`--instance-dir` holds everything one installation owns; this repository and
the source checkout only provide code, so any copy of the same release and any
checkout of the bound revision drive it:

```text
~/.azad/instances/<name>/
  .env                          private settings the deploy reads (mode 0600)
  terraform/<root>/             postgres, cloudsql or gcp-celld
    terraform.tfstate, .backup  the local backend's state
    terraform.tfvars.json       what setup wrote; edit it to change settings
    *.tfplan                    saved plans
    .terraform/                 Terraform's working data (TF_DATA_DIR)
    installer-state/            Cloudflare: the app's state and keys
    celld-install/              Google Cloud: instance keys, tools, install.log
```

Each root declares `backend "local" {}`; `init` points it at the instance's
state and must run before the other commands, and again after the directory or
this repository moves. Plain `terraform` commands in a root see none of this:
use the drivers. State, saved plans and the keys directories are sensitive
(database passwords, signing keys): **back up the whole instance directory**
and keep it private. To keep state in a remote backend instead, replace a
root's `backend` block and run Terraform yourself.

## Roots and modules

| Path | What it is |
| --- | --- |
| [`roots/postgres`](roots/postgres) | Azad on Cloudflare with an existing PostgreSQL database (Neon or any provider); optionally your own S3/GCS bucket |
| [`roots/cloudsql`](roots/cloudsql) | Azad on Cloudflare with a new Cloud SQL database in your Google Cloud project |
| [`roots/gcp-celld`](roots/gcp-celld) | Azad on Google Cloud: GKE Autopilot, Cloud SQL, Forgejo, regional load balancer |
| [`roots/bootstrap`](roots/bootstrap) | The scoped Cloudflare API tokens `scripts/bootstrap.ts` creates |
| [`modules/base`](modules/base), [`modules/base-postgres`](modules/base-postgres) | The two Cloudflare compositions |
| [`modules/installation`](modules/installation) | The Cloudflare deploy and uninstall handoff to the app's `cloudflare-install.ts` |
| [`modules/cloudflare/*`](modules/cloudflare) | R2 buckets and queue, Clerk DNS, DNS records, edge proxy, hostname route reservations |
| [`modules/gcp/*`](modules/gcp) | Cloud SQL, GKE Autopilot, Gateway, certificates, Backup for GKE, Cloud SQL Proxy Operator, agent machine |
| [`modules/kubernetes/*`](modules/kubernetes) | cert-manager, Forgejo, raw manifests |
| [`modules/celld/*`](modules/celld) | The celld fleet (StatefulSet with PgBouncer) and the app deploy handoff to `celld-install.ts` |
| [`modules/clerk/application`](modules/clerk/application) | Deletes an evaluation install's Clerk application on destroy |

Only stable, official providers are used: `hashicorp/google`,
`hashicorp/random`, `hashicorp/kubernetes`, `hashicorp/helm`, `hashicorp/http`,
`hashicorp/tls` and `cloudflare/cloudflare`. Each root commits its provider lock file.
[INPUTS.md](INPUTS.md) lists every input and whether it is required, derived,
generated or defaulted.

## Versioning and releases

Releases follow [semantic versioning](https://semver.org) with `v`-prefixed
tags (`v0.0.1`). While the major version is 0, a minor release may change
inputs, root layout or driver flags; read the release notes before upgrading
an installation. Pushing a tag `v<version>` that matches `package.json`'s
version runs every check and publishes a GitHub Release with:

- `azad-terraform-<version>.tar.gz`: the repository at that tag, under one
  top-level directory `azad-terraform-<version>/` (no `.git`, no
  `node_modules`); run `bun install --frozen-lockfile` inside it;
- `azad-terraform-<version>.tar.gz.sha256`: its checksum in `sha256sum` format.

`azad` pins a release; installations keep working with the release that
created them until you choose to upgrade.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the tests, type check, formatting
and the offline Terraform checks CI runs.

## License

No license has been chosen yet.
