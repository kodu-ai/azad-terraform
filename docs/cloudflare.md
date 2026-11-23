# Azad on Cloudflare

Two roots install Azad on Cloudflare (Workers, Pages, Durable Objects, R2,
Queues, Hyperdrive) in your Cloudflare account:

- `roots/postgres`: an existing PostgreSQL database you own, including Neon.
  Terraform never provisions, imports or deletes that database.
- `roots/cloudsql`: a new Cloud SQL for PostgreSQL 17 instance in your Google
  Cloud project, reached by Hyperdrive and the migration runner over public
  IPv4 with explicitly authorized networks.

`scripts/cloudflare.ts` drives both. `apply` provisions the fixed
infrastructure; `deploy` then runs the unpacked Azad release's
`payload/installer/cloudflare-install.js` with Terraform's handoff (see
[how-it-works.md](how-it-works.md)). Terraform's state and the app's install
state live in the installation's R2 bucket, the keys in the account's Secrets
Store.

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

Choose the **database provider and region**, the **web hostname** and the
**Mini Apps domain** ([Mini Apps](#mini-apps)). Cloud SQL
also needs an existing Google Cloud project and Application Default
Credentials; an existing database needs its direct TLS connection string.
Both use the seven fields in [credentials.env.example](../credentials.env.example):
one Cloudflare deployment token, three Clerk fields and three GitHub App
fields. [INPUTS.md](../INPUTS.md) classifies every value.

### An existing PostgreSQL database (including Neon)

Put a direct, schema-owner `DATABASE_URL` in the private credential file:

```sh
export AZAD_RELEASE=~/azad-release     # an unpacked Azad release
instance=~/.azad/instances/default
mkdir -m 700 -p "$instance"
cp credentials.env.example "$instance/.env" && chmod 600 "$instance/.env"
# Fill the Clerk/GitHub/Cloudflare fields and DATABASE_URL privately.
bun --no-env-file scripts/cloudflare.ts setup --database-provider postgres \
  --web-host board.example.com --miniapps-domain example-apps.com \
  --credentials "$instance/.env" --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts init  --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan  --root postgres --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/cloudflare.ts apply --root postgres --instance-dir "$instance" terraform.tfplan
bun --no-env-file scripts/cloudflare.ts deploy --root postgres --instance-dir "$instance"
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
  --miniapps-domain example-apps.com \
  --credentials "$instance/.env" --root cloudsql --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts init  --root cloudsql --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts plan  --root cloudsql --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/cloudflare.ts apply --root cloudsql --instance-dir "$instance" terraform.tfplan
bun --no-env-file scripts/cloudflare.ts deploy --root cloudsql --instance-dir "$instance"
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
client ID (with an App JWT), Clerk's DNS targets, the Mini Apps domain's zone
and, for Cloud SQL, public network information. It asks the release's
`settings.js` to derive the storage selection and resource names and to
validate the complete settings. It creates no cloud resources and does not
run Terraform.

It writes `<instance>/terraform/<root>/terraform.tfvars.json` once and adds what
it derives (GitHub App identity, a generated webhook secret, the Mini Apps
provider and domain) to the instance's private `.env`, which the deploy reads; a
`--credentials` file elsewhere is copied there with them. It refuses to
overwrite existing configuration; edit the saved files for later changes.
Copy a generated `GITHUB_WEBHOOK_SECRET` into the GitHub App's webhook
settings. The API hostname defaults to `api.<web-host>`.

### Mini Apps

Mini Apps run on the loader provider: inside the API Worker, each as a Dynamic
Worker with a SQLite Durable Object as its database, served on
`https://<app>.<domain>`. `--miniapps-domain <domain>` chooses the domain; it
must be apart from the Board's hosts (not one of them, above one or below
one), and can be either:

- **a zone of its own** in the same account, such as `example-apps.com`.
  Universal SSL covers `*.example-apps.com`.
- **a subdomain inside a zone** of the account, such as `apps.example.com`
  (the Board's own zone is fine). Universal SSL covers only a zone's
  first-level subdomains, so Terraform orders an advanced certificate pack
  for `example.com`, `apps.example.com` and `*.apps.example.com` (Cloudflare
  requires the zone apex in every pack). That needs **Advanced Certificate
  Manager** on the zone; setup refuses the domain without it, and the
  deployment token needs SSL and Certificates Edit on that zone.

Setup checks the zone, the certificate quota, that no `*.<domain>` record
exists yet and that storage is R2 (the loader keeps app releases and database
snapshots in this installation's R2 files bucket), then writes
`AZAD_SELF_HOST_MINIAPPS=loader` and `AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN` into
the `.env`. That is the one place the domain is set:

- `plan`, `apply` and `destroy` pass it to Terraform as
  `TF_VAR_miniapp_base_domain` (empty unless the loader is selected).
  `modules/cloudflare/miniapp-domain` finds the zone that holds the domain
  (the longest zone name it ends with) and adds a proxied wildcard record
  `*.<domain>` (`AAAA 100::`, commented with the installation's resource
  prefix) and, below the zone's apex, the certificate pack.
- `deploy` hands the `.env` to the release's installer, which routes
  `*.<domain>/*` to the API Worker. It refuses a domain other than the one
  Terraform last applied, so the DNS record and certificate exist first.

To change the domain later, edit `AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN`, then
`plan`, `apply` and `deploy`. Installed apps keep the provider they were
created with.

`--miniapps-domain none` writes `AZAD_SELF_HOST_MINIAPPS=disabled`, and Mini
Apps are off. With a `V3_CF_API_TOKEN` in the `.env` (Workers Scripts Edit and
D1 Edit in the same account) it writes `enabled` instead: Mini Apps then run
as Workers of their own with D1 databases.

### Your own object storage

Instead of this installation's R2 buckets, files and the Agent Connect release
mirror can live in a bucket you own: Google Cloud Storage (HMAC keys), Amazon
S3 or any S3-compatible service. Add `STORAGE_ADAPTER` (`gcs` or `s3`),
`STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` (`s3`
also `STORAGE_REGION` and, for non-AWS services, `STORAGE_ENDPOINT`) to the
credential file before setup. Setup writes the non-secret part as the
`storage` variable; the keys stay in the private file and reach the Worker as
secrets. No R2 bucket is created or bound. Releases share the bucket unless
`STORAGE_RELEASES_BUCKET` names another. Mini Apps on the loader need R2, so
pass `--miniapps-domain none`.

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
| Terraform | Cloud SQL and its generated password when selected; two R2 buckets (unless `storage` names your own), the offline queue, Clerk DNS records, hostname route reservations, the Neon CA registration when selected; the Mini Apps wildcard record and, below a zone's apex, its certificate pack |
| The release's `cloudflare-install.js` | Hyperdrive (caching disabled), the API Worker with its Durable Objects, Worker Loader and queue bindings and the Mini Apps route `*.<domain>/*`, migrations, Pages, secrets, custom domains, the Agent Connect release mirror and verification |
| The running app | Mini Apps: inside the API Worker on the loader provider, or Workers and D1 databases with `enabled` |

Fixed Cloudflare names match the app installer's naming contract, so it reuses
these resources; the deploy refuses names that differ. Worker and Pages
configuration stays with the app to avoid competing writers.

## Updates and recovery

With a new release unpacked:

```sh
export AZAD_RELEASE=~/azad-release-4.498.0
bun --no-env-file scripts/cloudflare.ts refresh --root postgres --instance-dir "$instance"
bun --no-env-file scripts/cloudflare.ts deploy  --root postgres --instance-dir "$instance"
```

`refresh` changes only `deployment.revision` and `deployment.version` (the
release's `sourceSha` and version). The deploy refuses any other release, and
the release's installer refuses one older than the release the installation
runs, or than one a deploy already started migrating to. Terraform never deploys the app, so
changing a setting or a variable can never put an older release back: `plan`
and `apply` change infrastructure only, and a `deploy` afterwards applies new
`.env` settings to the running release. Deploying again is also how you retry
a failed deploy, or redeploy the same revision.

A failed deploy writes its details to `installer-state/last-install-error.txt`.
`installer-state/` is a cache: the deploy refills its receipt and Agent Connect
manifest from the bucket, and writes the generated keys and the release key
into the Secrets Store as soon as they exist, create-only. The Secrets Store
gives values back only to a Worker bound to them, so keep the offline copy
`backup-keys --out DIR` writes, and never delete the installer state or keys
to retry a deployment: they decrypt the data in the database.

### Release updates from the console

With `updater_image` set (off by default on Cloudflare: set it to the image azad 0.2.0 published, `ghcr.io/kodu-ai/azad-updater@sha256:3959ed459010390940e6e9b6a151baeef3cccf42cd1be00553fab18918bb77ca`),
an admin can update the installation from its settings to a release azad.pro
runs, and `azad update` keeps working beside it. The deploy copies the pinned
updater image into the account's container registry and deploys the
installation's updater Worker, which runs each update in a Cloudflare
Container. Containers need the Workers Paid plan, and the deployment token
needs Workers Containers Edit ([INPUTS.md](../INPUTS.md#the-cloudflare-api-token)).
The keys and deploy credentials are bound to the updater Worker only; the API
gets a binding that can start an update and read its status. An update never
runs Terraform: a release that needs new infrastructure asks you to run the
CLI first.

## Uninstall

`cloudflare.ts destroy` is a complete uninstall of the installation's
Cloudflare side. Before Terraform deletes its own resources, a destroy-time
step runs the release's `payload/installer/cloudflare-install.js uninstall`
from its `payload/` (the release `--release` names, otherwise the one recorded
at the last apply), which removes what the app created: Mini App Workers bound
to this installation's API Worker and their D1 databases, the API Worker with
its custom domain, Mini Apps route and queue consumer, its code executor and image encoder Workers
(`code-<API Worker>`, `image-<API Worker>`), the Pages project with its domain
and CNAME,
and the Hyperdrive; it empties this installation's R2 buckets so Terraform can
delete them. Nothing is selected by a pattern alone, so other resources in the
account are untouched. It keeps your database, your own bucket, the Clerk
application, the keys and the state bucket: those keys still decrypt the data
in your database, so a later apply and deploy reinstall over it. Terraform
then deletes the Mini Apps wildcard record and certificate pack with its other
resources. Setting `deployment.enabled = false` on a running instance also
uninstalls it.

On the `cloudsql` root, Cloud SQL's deletion protection is on by default. A
destroy then uninstalls everything above and stops with an error at the Cloud
SQL instance, which it keeps with its database and user. To delete them too,
set `gcp.deletion_protection` to `false`, apply, then destroy: deleting the
instance removes the database and user, so clients that are still connected
(Hyperdrive's pool closes its connections only after a while) cannot stop the
destroy.

## Decisions and limits

| Topic | Resolution |
| --- | --- |
| App deployment is not a provider resource graph | `deploy` runs the app's own installer with the handoff Terraform outputs, outside any plan. Migrations, builds, secrets and the release mirror stay there. Only the destroy-time uninstall is a provisioner. |
| Cloudflare provider coverage | The provider could manage Workers, Pages, D1 and Hyperdrive, but reproducing the Worker configuration and Durable Object migration history would create a second owner. Only fixed R2, queue, DNS, route and certificate resources are managed here. |
| The Mini Apps domain | Set once, in the `.env`, which the app reads. The driver passes it to Terraform on every run instead of copying it into the variables, so the two cannot drift; `deploy` checks Terraform applied it. |
| Hyperdrive to Cloud SQL networking | Public IPv4 with explicit authorized networks for both callers. Setup snapshots Cloudflare's published ranges into the variables; Terraform does not refresh them silently. |
| TLS to Cloud SQL | Encrypted connections are enforced; the DSN uses `sslmode=require`, which encrypts without verifying the server certificate. Existing databases can use `verify-full` with a registered CA. |
| Secrets | Cloud SQL's generated password and DSN are sensitive but **stored in Terraform state and saved plans**. An existing database's DSN is in saved plans only. Provider tokens come from the private `.env`; app secrets stay there and in the installer state. |
| State backend | R2's S3 API in the installation's own bucket, with Terraform's create-only lock object (R2 commits a conditional write atomically). R2 keeps no object versions; `init` keeps the local state it moved. |
| Partial failure and drift | Keep both states and retry. Terraform observes only its own resources; destroy resumes after a partial failure. |
