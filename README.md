# Azad Terraform

This repo installs a self-hosted [Azad](https://azad.pro) into your own cloud
accounts. It's a set of Terraform roots and modules, plus three small Bun
scripts (we call them drivers) that run Terraform for one installation and
install an Azad release on what Terraform created.

Most people never run it by hand: the [`azad` CLI](https://github.com/kodu-ai/azad-cli)
downloads a release of this repo and a signed Azad release, checks both, and
drives them for you. This README is for when you want to run it yourself.

## Pick a setup

| You want | You run |
| --- | --- |
| Azad on Cloudflare, with a PostgreSQL you already have (Neon or anything else) | `scripts/cloudflare.ts --root postgres` |
| Azad on Cloudflare, with a new Cloud SQL database in your Google Cloud project | `scripts/cloudflare.ts --root cloudsql` |
| Azad on Google Cloud (GKE Autopilot, Cloud SQL, its own Git server), with Cloudflare only for DNS | `scripts/gcp.ts` |

## What you need

- [Terraform](https://developer.hashicorp.com/terraform/install) 1.13.4 or newer (1.x).
- [Bun](https://bun.sh) 1.4.4 or newer.
- An unpacked Azad release: a directory with `release.json`, `payload/` and
  `web/`. The `azad` CLI downloads a signed one and verifies it; by hand, you
  point the drivers at one with `--release <dir>` or `AZAD_RELEASE`. The
  drivers run the installer entrypoints it bundles
  (`payload/installer/*.js`), so you need no app source code.
- A Cloudflare account that holds your domain's zone, and an API token for it.
  [INPUTS.md](INPUTS.md#the-cloudflare-api-token) lists its permissions, and
  `scripts/bootstrap.ts` can mint one for you ([docs/token-bootstrap.md](docs/token-bootstrap.md)).
- For Mini Apps on Cloudflare: a domain for them, apart from your Board's
  hosts. Either a zone of its own in the same account (`example-apps.com`), or
  a subdomain of one of its zones (`apps.example.com`), which needs
  Cloudflare's Advanced Certificate Manager on that zone.
- A [Clerk](https://clerk.com) application, and a GitHub App (optional on Google Cloud).
- For Cloud SQL or Google Cloud: the [gcloud CLI](https://cloud.google.com/sdk/docs/install),
  signed in with `gcloud auth application-default login` (and `gcloud auth login` for Google Cloud).
- macOS or Linux. On Windows, use WSL.

## Get the code

Download a release of this repo and check it:

```sh
version=0.4.0
base="https://github.com/kodu-ai/azad-terraform/releases/download/v$version"
curl -fsSLO "$base/azad-terraform-$version.tar.gz"
curl -fsSLO "$base/azad-terraform-$version.tar.gz.sha256"
sha256sum --check "azad-terraform-$version.tar.gz.sha256"   # macOS: shasum -a 256 --check
tar -xzf "azad-terraform-$version.tar.gz" && cd "azad-terraform-$version"
bun install --frozen-lockfile
```

Or clone it: `git clone https://github.com/kodu-ai/azad-terraform && cd azad-terraform && bun install --frozen-lockfile`.

Then tell the drivers where the unpacked Azad release is:

```sh
export AZAD_RELEASE=~/azad-release   # holds release.json, payload/ and web/
```

## Quick start: Cloudflare

Every installation lives in its own instance directory, outside this repo.
Make one and put your secrets in its `.env` ([what goes in it](#what-you-provide)):

```sh
instance=~/.azad/instances/default
mkdir -m 700 -p "$instance"
cp credentials.env.example "$instance/.env" && chmod 600 "$instance/.env"
$EDITOR "$instance/.env"
```

Then run these in order. This is the `postgres` root; for Cloud SQL, use
`--database-provider cloudsql --project-id my-project` and `--root cloudsql`.

```sh
bun --no-env-file scripts/cloudflare.ts setup --database-provider postgres \
  --web-host board.example.com --miniapps-domain example-apps.com \
  --credentials "$instance/.env" --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts init  --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan  --root postgres --instance-dir "$instance" -out=terraform.tfplan
# Read the plan. Happy with it? Apply exactly that plan, then deploy the app:
bun --no-env-file scripts/cloudflare.ts apply  --root postgres --instance-dir "$instance" terraform.tfplan
bun --no-env-file scripts/cloudflare.ts deploy --root postgres --instance-dir "$instance"
```

A few things worth knowing:

- `setup` only reads (your Cloudflare account and zones, your GitHub App,
  Clerk's DNS targets) and writes `terraform/<root>/terraform.tfvars.json`
  once. It also adds a few derived keys to your `.env`, including a generated
  `GITHUB_WEBHOOK_SECRET`: paste that into your GitHub App's webhook
  settings. `init` creates the installation's R2 bucket for its state.
  `apply` creates the infrastructure; `deploy` installs the release on it.
- `--miniapps-domain` is where Mini Apps serve: each app on
  `https://<app>.<domain>`. Setup writes it to the `.env` as
  `AZAD_SELF_HOST_MINIAPPS=loader` and `AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN`,
  and Terraform adds a proxied wildcard DNS record for it (and, for a
  subdomain of a zone, a certificate). `--miniapps-domain none` turns Mini
  Apps off. [docs/cloudflare.md](docs/cloudflare.md#mini-apps) has the details.
- If your token can see more than one Cloudflare account, add `--account-id`.
- Cloud SQL: setup leaves the region at `me-central2`. To change it, add
  `"region"` under `gcp` in the tfvars file before you plan. If you'll run
  `apply` on another machine or behind a proxy, pass `--runner-cidr`.

The details are in [docs/cloudflare.md](docs/cloudflare.md).

## Quick start: Google Cloud

```sh
gcloud auth login && gcloud auth application-default login
instance=~/.azad/instances/default
mkdir -m 700 -p "$instance"
cp credentials.env.example "$instance/.env" && chmod 600 "$instance/.env"
$EDITOR "$instance/.env"   # the GitHub App: fill all five GITHUB_APP_* keys or remove them

bun --no-env-file scripts/gcp.ts setup --credentials "$instance/.env" \
  --project-id my-project --region europe-west1 \
  --web-host azad.example.com --account-id <cloudflare-account-id> \
  --instance-dir "$instance"
bun --no-env-file scripts/gcp.ts init  --instance-dir "$instance"
bun --no-env-file scripts/gcp.ts plan  --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" terraform.tfplan
# A first install plans twice: the cluster first, then everything else.
bun --no-env-file scripts/gcp.ts plan  --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" terraform.tfplan
bun --no-env-file scripts/gcp.ts deploy --instance-dir "$instance"
```

Your Cloudflare account ID is the 32-character ID in the dashboard's URL.
Add `--evaluation` for a cheap throwaway install (Spot nodes, the smallest
database, and a destroy that removes everything). Mini Apps serve on
`<app>.apps.<web-host>` in the same zone. The second apply and the deploy
take about half an hour together. The details, including disk backups and an
agent machine, are in [docs/google-cloud.md](docs/google-cloud.md).

## What you provide

There are three places. [INPUTS.md](INPUTS.md) has every key and field; these
are the ones you'll actually touch.

**Your shell**

| Name | Required? | What it's for | Example |
| --- | --- | --- | --- |
| `AZAD_RELEASE` | Yes, unless you pass `--release` | The unpacked Azad release that `setup`, `refresh`, `plan`, `apply`, `deploy`, `destroy` and `backup-keys` use, and `init` when the installation has its own backend | `~/azad-release` |
| Google credentials | Cloud SQL and Google Cloud | Application Default Credentials for Terraform and the deploy | `gcloud auth application-default login` |

Don't export `CLOUDFLARE_API_TOKEN`: the drivers read it from the instance's
`.env` and hand it to Terraform themselves.

**`<instance>/.env`** (keep it `chmod 600`; start from [credentials.env.example](credentials.env.example))

| Key | Required? | What it's for | Example |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Yes | Terraform and the deploy | |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Yes | Sign-in, from one Clerk application | `pk_live_…`, `sk_live_…` |
| `CLERK_WEBHOOK_SECRET` | Cloudflare: yes. Google Cloud: optional | Clerk's webhook to Azad | `whsec_…` |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET` | Cloudflare: yes. Google Cloud: optional | Your GitHub App. The PEM key goes in double quotes with `\n` for newlines | `123456` |
| `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` | Google Cloud: with the App. Cloudflare: setup adds them | The App's name and OAuth client | `my-azad`, `Iv23li…` |
| `DATABASE_URL` | `postgres` root only | A direct (not pooled) connection with TLS, as the schema owner | `postgresql://azad:…@db.example.com/azad?sslmode=require` |
| `AZAD_SELF_HOST_DATABASE_CA` or `AZAD_SELF_HOST_DATABASE_CA_CERT_ID` | With `sslmode=verify-full` | How Hyperdrive checks the database's certificate: Neon's CA, or a CA you uploaded to Cloudflare | `neon-isrg-root-x1` |
| `AZAD_SELF_HOST_MINIAPPS`, `AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN` | Cloudflare: setup adds them | Mini Apps: `loader` on that domain, or `disabled`. Edit them to change the domain, then plan, apply and deploy | `loader`, `example-apps.com` |
| `GITHUB_WEBHOOK_SECRET` | No | Generated if missing; goes in the App's webhook settings | |
| `STORAGE_*` | No | Your own S3 or GCS bucket instead of R2 (Cloudflare; then Mini Apps need `--miniapps-domain none`) | `STORAGE_ADAPTER=gcs` |

**`<instance>/terraform/<root>/terraform.tfvars.json`** (setup writes it; edit it, then plan and apply)

| Field | Required? | What it's for | Default |
| --- | --- | --- | --- |
| Account, hostnames, `deployment` | Yes; setup writes them | Where to install, the release (`revision`, `version`), and where the instance's files are | |
| `gcp.region` | No | Cloud SQL's region | `me-central2` |
| `gcp.tier`, `gcp.deletion_protection` | No | Cloud SQL's size, and whether Terraform may delete it | `db-custom-2-7680`, `true` |
| `deletion_protection`, `database`, `api_replicas`, `disk_backups` | No | Google Cloud: protection, database size, API nodes, disk snapshots | `true`, `db-custom-1-3840`, `2`, `daily` |

## Where your state lives

An installation keeps its state in its own cloud, in one private bucket that
`init` creates:

- **Cloudflare:** the R2 bucket `<resource prefix>-install` in your account.
  Terraform's state is `terraform/<root>.tfstate`, locked while a command
  runs. The app's keys (`secrets` and `release-key`) and settings live in the
  account's [Secrets Store](https://developers.cloudflare.com/secrets-store/),
  readable only by a Worker bound to them.
- **Google Cloud:** the GCS bucket `<name>-<project hash>-install` in your
  project, versioned. The keys live in the project's Secret Manager.

The bucket also holds the app's install state (`install/`): what release runs,
the Agent Connect release it mirrored, and the operation record that lets
only one change run at a time. The instance directory is a cache:

```text
~/.azad/instances/<name>/
  .env                       your settings and secrets
  terraform/<root>/
    terraform.tfvars.json    what setup wrote
    backend.tfbackend        the state bucket (init writes it, with backend.json)
    *.tfplan                 saved plans
    installer-state/         Cloudflare: the deploy's copy of the keys and receipt
    celld-install/           Google Cloud: the same, plus tools and install.log
```

Keep it private: it holds passwords and the keys that decrypt your data. Keep
an offline copy of the keys too; on Cloudflare only the installation's own
Worker can read them back from the Secrets Store:

```sh
bun --no-env-file scripts/cloudflare.ts backup-keys --root postgres --instance-dir "$instance" --out ~/azad-keys-backup
```

Use the drivers rather than plain `terraform`, which doesn't know where this
state is. More in [docs/how-it-works.md](docs/how-it-works.md).

### Your own Terraform backend

To keep Terraform's state somewhere else, such as your own S3 bucket, HCP
Terraform or Azure Storage, write a `backend_override.tf` in the instance's
`terraform/<root>/` directory. It holds a Terraform `backend` block of any
type, or a `cloud` block:

```hcl
terraform {
  cloud {
    organization = "my-team"
    workspaces {
      name = "azad"
    }
  }
}
```

Then run `init --release <dir>`. From then on the drivers run Terraform with
that backend, from a copy of this release's root beside the file. The app's
install state and keys stay in the installation's bucket.

The first `init` moves the state from the bucket when the backend has none:
it pushes it, reads it back and compares it, keeps a copy as
`terraform.tfstate.before-own-backend-<time>`, and leaves only a pointer in
the bucket. The pointer records the installation's current state, and
every command that changes the state updates it. From then on the drivers
refuse to run without the file, or against a backend that holds anything but
the current state (an empty backend, an older copy, another installation's),
so no machine plans an empty or stale installation. A backend that already
holds this installation's state is used as it is. One that holds another
state is refused, and so is the bucket itself. A new installation can start
in its own backend: add the file before its first `init`.

- Credentials come from the backend's own login: your AWS profile,
  `terraform login` for HCP Terraform, gcloud for GCS. The drivers never pass
  the bucket's R2 keys to it.
- On HCP Terraform, set the workspace's execution mode to **Local**: plans
  and applies must run on your machine, because a destroy runs local steps.
- To switch to another backend of your own, change the file and run
  `init -migrate-state`. Terraform copies the state, and the next command
  that changes it makes the old copy stale, so a machine still on the old
  backend is refused. A copy taken before another machine changed the state
  is refused too: migrate again.
- Every machine that runs the drivers for this installation needs the same
  file. A local backend lives on one machine only.
- A command that changes the state marks the pointer while it runs. If it
  stops before it records its result, other machines are refused until
  `init` runs where it ran, or, once you have confirmed it stopped, until
  you pass `--take-over <operation id>` (the refusal names it).
- To bring the state back to the bucket, save it with `state pull` while the
  file is in place, delete the file, run `init`, then
  `state push -force <saved file>`.

## Updating

Unpack the new Azad release, record it and deploy it:

```sh
export AZAD_RELEASE=~/azad-release-4.498.0
bun --no-env-file scripts/cloudflare.ts refresh --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts deploy  --root postgres --instance-dir "$instance"
```

On Google Cloud it's the same with `scripts/gcp.ts` and no `--root`.
`refresh` records the release's `sourceSha` and version as
`deployment.revision` and `deployment.version`; `deploy` refuses any other
release, and the release's installer refuses one older than what the
installation already runs, so a stale release never goes back on. Terraform
never deploys the app: `plan` and `apply` change infrastructure only, so run
them when you change a setting in `terraform.tfvars.json` or the Mini Apps
domain in `.env`, or move to a newer release of this repo (download it,
`bun install`, and run `init` from the new copy first). Then `deploy`, which
also applies changed settings from `.env`.

### From the console

With `updater_image` set (the default on Google Cloud; on Cloudflare you set it), an admin can also update
to a release azad.pro runs from the installation's settings: a Cloudflare
Container on Cloudflare, a Kubernetes Job on Google Cloud
([docs/cloudflare.md](docs/cloudflare.md#release-updates-from-the-console),
[docs/google-cloud.md](docs/google-cloud.md#release-updates-from-the-console)).
These updates never run Terraform. On Cloudflare the deployment token also
needs **Workers Containers Edit**, and the account the Workers Paid plan.

### One change at a time

`apply`, `destroy`, `import`, the `state` commands that write, `deploy` and an
`init` that points the bucket at your own backend hold the installation's
operation record while they run, so they never overlap each other or a
release update. If a run was killed or a machine went away, its record stays:
once you have confirmed that run and everything it started (such as a deploy
still running) have stopped, pass `--take-over <operation id>` (the refusal
names it). A deploy that failed keeps its release: the next deploy must
install that release or a later one. Terraform's own state lock works the
same way: after a killed run, `force-unlock <lock id>` releases it.

## Destroying

```sh
bun --no-env-file scripts/cloudflare.ts destroy --root postgres --instance-dir "$instance"
bun --no-env-file scripts/gcp.ts destroy --instance-dir "$instance"
```

- On Cloudflare, destroy is a full uninstall: Workers, Pages, Hyperdrive, Mini
  Apps with their DNS record and certificate, and this installation's R2
  buckets **with their files**. It keeps your own database, your own bucket,
  the Clerk application, the keys and the state bucket. It runs the release's
  uninstall, so it needs `--release` too.
- Deletion protection is on by default for Cloud SQL, and on Google Cloud for
  the cluster, database and agent machine. It only keeps those: destroy still
  removes everything else first (on Google Cloud, that includes the in-cluster
  Git repositories) and then stops with an error. To delete them too, set
  `deletion_protection` to `false` (under `gcp` for Cloud SQL), apply, then
  destroy.

## Versioning and releases

Releases of this repo are git tags like `v0.4.0`, following semver. Each one
publishes `azad-terraform-<version>.tar.gz` (a single
`azad-terraform-<version>/` folder) and its `.sha256`. While we're on 0.x, a
release may change inputs or flags, so read the release notes before you
upgrade. The `azad` CLI pins one release and its checksum.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the checks and how a release is cut.

## More

- [docs/how-it-works.md](docs/how-it-works.md): the drivers, the release contract, roots and modules
- [INPUTS.md](INPUTS.md): every setting, secret and variable
- [docs/cloudflare.md](docs/cloudflare.md) and [docs/google-cloud.md](docs/google-cloud.md): each target in depth
- [docs/token-bootstrap.md](docs/token-bootstrap.md): minting scoped Cloudflare tokens

No license has been chosen yet.
