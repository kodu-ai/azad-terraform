# Azad on Cloudflare

Two roots install Azad on Cloudflare (Workers, Pages, Durable Objects, R2,
Queues, Hyperdrive) in your Cloudflare account:

- `roots/postgres`: an existing PostgreSQL database you own, including Neon.
  Terraform never provisions, imports or deletes that database.
- `roots/cloudsql`: a new Cloud SQL for PostgreSQL 17 instance in your Google
  Cloud project, reached by Hyperdrive and the migration runner over public
  IPv4 with explicitly authorized networks.

`scripts/cloudflare.ts` drives both. One apply provisions the fixed
infrastructure and then hands the app deployment to the Azad source checkout's
`scripts/self-host/cloudflare-install.ts` (see the [README](../README.md)).

## Account ownership and location

This is one installation in **your** Cloudflare account and your selected
database account/project and region, with one deployment-wide application
database and file store.

| Data / processing | Where it goes |
| --- | --- |
| Main application records | The selected PostgreSQL database and its provider region |
| Files and app-package bytes | This installation's R2 buckets, or your own S3-compatible bucket (`storage`) |
| API, Mini App execution, Durable Object state, D1 and queues | Your Cloudflare account, under those services' own storage and processing location terms |
| Login, Git repositories, model calls and optional integrations | The configured external providers and their own data-processing terms |

Account ownership and a database region do not geographically pin every
Cloudflare service or external-provider request.

## Choose the database provider

Choose the **database provider and region** and the **web hostname**. Cloud SQL
also needs an existing Google Cloud project and Application Default
Credentials; an existing database needs its direct TLS connection string.
Both use the seven fields in [credentials.env.example](../credentials.env.example):
one Cloudflare deployment token, three Clerk fields and three GitHub App
fields. [INPUTS.md](../INPUTS.md) classifies every value.

### An existing PostgreSQL database (including Neon)

Put a direct, schema-owner `DATABASE_URL` in the private credential file:

```sh
export AZAD_SOURCE=~/src/azad          # your kodu-ai/azad-ide-web checkout
instance=~/.azad/instances/default
mkdir -m 700 -p "$instance"
cp credentials.env.example "$instance/.env" && chmod 600 "$instance/.env"
# Fill the Clerk/GitHub/Cloudflare fields and DATABASE_URL privately.
bun --no-env-file scripts/cloudflare.ts setup --database-provider postgres \
  --web-host board.example.com --credentials "$instance/.env" \
  --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts init  --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan  --root postgres --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/cloudflare.ts apply --root postgres --instance-dir "$instance" terraform.tfplan
```

Use Neon's **direct endpoint**, not its pooler, with `sslmode=verify-full`. The
driver passes the DSN from the private file as `TF_VAR_database_url`; it never
writes it to the generated variables, and Terraform state keeps only a digest
of it. Saved plans do contain it, because a plan records its variables: keep
them private. Hyperdrive and migrations use this same connection.

Hyperdrive keeps up to 20 connections to the database, beside the migration
runner and your own clients. Give the database room above that: Cloud SQL's
shared-core tiers default to `max_connections = 25`, which runs out during
migrations.

For automatic registration of Neon's public CA in Cloudflare, add
`AZAD_SELF_HOST_DATABASE_CA=neon-isrg-root-x1` to the credential file. Setup
writes `database_ca`, and `plan`, `apply` and `destroy` pass the ISRG Root X1
certificate from this machine's OS trust store to Terraform; nothing is
downloaded.

Neon documents its Terraform provider as community-maintained and
unsupported, so there is no Neon provider and no automatic Neon project
creation.

### Cloud SQL in your Google Cloud project

```sh
bun --no-env-file scripts/cloudflare.ts setup --database-provider cloudsql \
  --project-id my-project --web-host board.example.com \
  --credentials "$instance/.env" --root cloudsql --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts init  --root cloudsql --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan  --root cloudsql --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/cloudflare.ts apply --root cloudsql --instance-dir "$instance" terraform.tfplan
```

Setup discovers a single accessible Cloudflare account, Cloudflare's published
IPv4 ranges and this machine's public IPv4. If the token spans accounts, pass
`--account-id`. If apply runs on another machine, an HTTP proxy is configured
or IPv4 discovery fails, pass `--runner-cidr` with the direct PostgreSQL egress
address. Cloud SQL uses a Terraform-generated password and a derived instance
name. Review the account, origins, region (default `me-central2`) and allowed
networks in the generated variables before applying.

## What setup does

Setup only reads: Cloudflare accounts and zones, the GitHub App's slug and
client ID (with an App JWT), Clerk's DNS targets and, for Cloud SQL, public
network information. It asks the app (`settings.ts`) to derive the storage
selection and resource names and to validate the complete settings. It creates
no cloud resources and does not run Terraform.

It writes `<instance>/terraform/<root>/terraform.tfvars.json` once and adds what
it derives (GitHub App identity, a generated webhook secret, the Mini Apps
switch) to the instance's private `.env`, which the deploy reads; a
`--credentials` file elsewhere is copied there with them. It refuses to
overwrite existing configuration; edit the saved files for later changes.
Copy a generated `GITHUB_WEBHOOK_SECRET` into the GitHub App's webhook
settings. The API hostname defaults to `api.<web-host>`.

### Your own object storage

Instead of this installation's R2 buckets, files and the Agent Connect release
mirror can live in a bucket you own: Google Cloud Storage (HMAC keys), Amazon
S3 or any S3-compatible service. Add `STORAGE_ADAPTER` (`gcs` or `s3`),
`STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` (`s3`
also `STORAGE_REGION` and, for non-AWS services, `STORAGE_ENDPOINT`) to the
credential file before setup. Setup writes the non-secret part as the
`storage` variable; the keys stay in the private file and reach the Worker as
secrets. No R2 bucket is created or bound. Releases share the bucket unless
`STORAGE_RELEASES_BUCKET` names another.

### Before the GitHub App exists

A GitHub App can only be registered in GitHub's UI. To deploy first, put
placeholder `GITHUB_APP_*` values (including `GITHUB_APP_SLUG` and
`GITHUB_APP_CLIENT_ID`) and `AZAD_SELF_HOST_GITHUB_APP_PENDING=1` in the
credential file. Setup then reads nothing from GitHub and sets
`github_app_pending = true`. GitHub sign-in, repositories and webhooks do not
work, and the `github_app` output says PENDING. Replace the placeholders with
the real App's values, set the variable to `false` and apply.

### Clerk's production domain

Setup reads Clerk's DNS targets with the secret key, and Terraform creates the
missing CNAMEs before the deploy runs. The deploy then waits (up to 30 minutes)
until Clerk has verified them and serves its Frontend API over HTTPS. "Verify"
on Clerk's Domains page makes Clerk check at once.

### Board hostnames and zone-wide Worker routes

A zone-wide Workers route such as `*.example.com/*` wins over the API Worker's
custom domain and the Pages domain. Setup records each host's zone in
`host_zones`, and Terraform adds one hostname route per host with no Worker
(`modules/cloudflare/host-routes`): more specific than any wildcard, it runs
nothing and leaves existing routes alone. Destroy removes it.

## Ownership

| Owner | Resources / operations |
| --- | --- |
| Terraform | Cloud SQL and its generated password when selected; two R2 buckets (unless `storage` names your own), the offline queue, Clerk DNS records, hostname route reservations, the Neon CA registration when selected |
| The app's `cloudflare-install.ts` | Hyperdrive (caching disabled), the API Worker with its Durable Objects, Worker Loader and queue bindings, migrations, Pages, secrets, custom domains, the Agent Connect release mirror and verification |
| The running app | Mini App Workers and D1 databases when Mini Apps are enabled |

Fixed Cloudflare names match the app installer's naming contract, so it reuses
these resources; the deploy refuses names that differ. Worker and Pages
configuration stays with the app to avoid competing writers.

## Updates and recovery

After pulling a new app revision into the source checkout:

```sh
bun --no-env-file scripts/cloudflare.ts refresh --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts init    --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan    --root postgres --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/cloudflare.ts apply   --root postgres --instance-dir "$instance" terraform.tfplan
```

`refresh` changes only `deployment.revision` (the source's `HEAD`). The deploy
checks the checkout's `HEAD` against it: use a clean checkout. The deploy
reruns when the revision, the settings, the connection or configuration, or a
resource it receives changes; the settings digest skips the guided installer's
own `AZAD_CLI_*` answers, and where the settings file, state and source
checkout live is not part of it, so moving them does not redeploy. A failed
deploy retries on the next apply. An explicit redeploy:

```sh
bun --no-env-file scripts/cloudflare.ts apply --root postgres --instance-dir "$instance" \
  -replace='module.base.module.installation.terraform_data.install[0]'
```

Terraform hides the deploy's output because its input holds the DSN; a failed
deploy writes its details to `installer-state/last-install-error.txt`.

Back up the whole instance directory: Terraform state and `installer-state/`.
Generated passwords stay stable through normal applies because Terraform keeps
them in state. Never delete the installer state or keys to retry a deployment:
they decrypt the data in the database.

## Uninstall

`cloudflare.ts destroy` is a complete uninstall of the installation's
Cloudflare side. Before Terraform deletes its own resources, a destroy-time
step runs the app's `cloudflare-install.ts uninstall` (from `--source`), which
removes what the app created: the Mini App Workers bound to this
installation's API Worker and their D1 databases, the API Worker with its
custom domain and queue consumer, the Pages project with its domain and CNAME,
and the Hyperdrive; it empties this installation's R2 buckets so Terraform can
delete them. Nothing is selected by a pattern alone, so other resources in the
account are untouched. It keeps your database, your own bucket, the Clerk
application and the installer state: those keys still decrypt the data in
your database, so a later apply reinstalls over it. Setting
`deployment.enabled = false` on a running instance also uninstalls it.
Cloud SQL deletion protection needs an explicit change before destroy.

## Decisions and limits

| Topic | Resolution |
| --- | --- |
| App deployment is not a provider resource graph | `terraform_data` runs the app's own installer after the infrastructure exists. Migrations, builds, secrets and the release mirror stay there. No provisioner runs during plan or validate. |
| Cloudflare provider coverage | The provider could manage Workers, Pages, D1 and Hyperdrive, but reproducing the Worker configuration and Durable Object migration history would create a second owner. Only fixed R2, queue, DNS and route resources are managed here. |
| Hyperdrive to Cloud SQL networking | Public IPv4 with explicit authorized networks for both callers. Setup snapshots Cloudflare's published ranges into the variables; Terraform does not refresh them silently. |
| TLS to Cloud SQL | Encrypted connections are enforced; the DSN uses `sslmode=require`, which encrypts without verifying the server certificate. Existing databases can use `verify-full` with a registered CA. |
| Secrets | Cloud SQL's generated password and DSN are sensitive but **stored in Terraform state and saved plans**. An existing database's DSN is in saved plans only. Provider tokens come from the private `.env`; app secrets stay there and in the installer state. |
| State backend | Local state in the instance directory. For a remote backend, replace the root's `backend` block and run Terraform yourself. |
| Partial failure and drift | Keep both states and retry. Terraform observes only its own resources; destroy resumes after a partial failure. |
