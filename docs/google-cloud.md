# Azad on Google Cloud

The `gcp-celld` root runs Azad in your Google Cloud project on GKE Autopilot,
with no Cloudflare runtime; Cloudflare only serves DNS for your domain.
`scripts/gcp.ts` drives it. One apply creates the infrastructure and then runs
the Azad source checkout's `scripts/self-host/celld-install.ts` to deploy the
app (see [how-it-works.md](how-it-works.md)).

## What gets created

| Part | Where |
| --- | --- |
| API and web app | [celld](https://github.com/denoland/celld) fleets (`azad-api`, `azad-web`) on a GKE Autopilot cluster, `<name>-celld` |
| Durable Object, queue and file state | One GCS bucket, `<name>-fleet-<suffix>`, written by celld |
| Database | Cloud SQL for PostgreSQL, reached only through the Cloud SQL Auth Proxy with the API pods' IAM identity (Google's Cloud SQL Proxy Operator injects it; cert-manager serves its webhooks). Each API pod runs PgBouncer, which keeps warm connections through the proxy |
| Project repositories | Forgejo inside the cluster (official Helm chart), reached only by the API |
| HTTPS | A GKE Gateway: a regional external Application Load Balancer on a regional static IP, with Google-managed regional certificates (Certificate Manager, DNS authorization) and a proxy-only subnet in the default VPC (`10.127.0.0/23` unless `proxy_only_subnet_range` says otherwise) |
| DNS | `A` records for `<host>`, `api.<host>` and `*.apps.<host>`, the certificate validation CNAMEs and Clerk's CNAMEs, in your Cloudflare zone. The `A` records are written only once the load balancer serves all three hosts over HTTPS. Existing records are never changed |
| Mini Apps | Run inside the API fleet, served at `<app>.apps.<host>` |
| Agent machine (optional) | One Compute Engine VM for agents, `<name>-agents`, without a public address; only the cluster's pods reach its SSH |
| Disk backups | Backup for GKE snapshots of the `azad` namespace's disks on the schedule chosen at setup |

The installation name (`<name>`) is derived from the hostname, so several
installations can share one project. A VPC has one proxy-only subnet per
region: a second installation in the same project and region sets
`proxy_only_subnet_range = null` to use the first one's, and the installation
that created the subnet is destroyed last. Terraform enables the Compute, GKE,
Cloud SQL and Certificate Manager APIs it needs.

## Before you start

- A Google Cloud project with billing where you can create clusters, Cloud SQL
  instances, buckets and IAM bindings (Owner, or Editor plus Project IAM
  Admin).
- The domain's zone in your Cloudflare account, and a Cloudflare token with
  Zone Read, DNS Write, SSL and Certificates Write and Config Settings Write on
  that zone ([docs/token-bootstrap.md](token-bootstrap.md) can mint it).
- Terraform 1.13.4+, Bun 1.4.4+, and the gcloud CLI signed in twice:
  `gcloud auth application-default login` for Terraform and the deploy, and
  `gcloud auth login`, which destroy uses.
- An Azad source checkout with its dependencies installed (`--source` or
  `AZAD_SOURCE`).

## Install

Put the credentials in the instance directory's private `.env`:

```sh
CLOUDFLARE_API_TOKEN=...
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CLERK_WEBHOOK_SECRET=whsec_...   # optional until the webhook exists
# Either all five GitHub App values, or none:
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
```

Then:

```sh
export AZAD_SOURCE=~/src/azad
instance=~/.azad/instances/default
bun --no-env-file scripts/gcp.ts setup --credentials "$instance/.env" \
  --project-id my-project --region europe-west1 \
  --web-host azad.example.com --account-id <cloudflare-account-id> \
  --instance-dir "$instance" [--evaluation] \
  [--disk-backups hourly|daily|weekly|off] [--agent-machine TYPE|none]
bun --no-env-file scripts/gcp.ts init  --instance-dir "$instance"
bun --no-env-file scripts/gcp.ts plan  --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" terraform.tfplan
# A first install: plan and apply once more for everything else.
bun --no-env-file scripts/gcp.ts plan  --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" terraform.tfplan
```

- `setup` asks the app to validate the credential file, reads the zone and
  Clerk's DNS targets, then writes
  `<instance>/terraform/gcp-celld/terraform.tfvars.json` once. The credentials
  stay in the `.env`; the deploy reads it directly, so none of them enters
  Terraform state. The secrets Terraform generates (the database and Forgejo
  passwords, the agent machine's keys) do.
- Before the cluster exists, `plan` covers only the cluster and Clerk's DNS
  records (`gcp.ts phase` prints `cluster`), because the Kubernetes resources
  are planned against the cluster. Once it exists (`phase` prints `full`), the
  next plan covers everything else and deploys the app. Later updates are a
  single plan.
- `--evaluation` chooses Spot nodes, the smallest database without backups,
  and a destroy that removes everything, including the Clerk application the
  installer created.

## Settings without a question

Change these in `<instance>/terraform/gcp-celld/terraform.tfvars.json`, then
plan and apply:

| Variable | Default | What it changes |
| --- | --- | --- |
| `database` | `db-custom-1-3840`, 10 GB, backups on | Cloud SQL tier, disk size, backups and flags |
| `api_replicas` | `2` | API fleet nodes |
| `disk_backups` | `daily` | Backup for GKE schedule and `retain_days` |
| `agent_machine.disk_size_gb` | `100` | The agent machine's disk |
| `cloudflare_proxy`, `manage_ssl_rule` | `false`, `true` | Proxy the hostnames through Cloudflare with an Origin CA certificate |
| `proxy_only_subnet_range` | `10.127.0.0/23` | The load balancer's proxy-only subnet; `null` to share one |
| `ready_timeout_minutes` | `45` | How long DNS and deploys wait for the load balancer and the new revision |
| `ssh_allowed_private_cidrs` | `[]` | More private networks the API may SSH into |
| `spot`, `deletion_protection` | `false`, `true` | Spot nodes; destroy protection |

## After the install

- **Agent machine:** in project setup, choose **A server over SSH** with the
  host, port and user from `gcp.ts output --instance-dir "$instance"
  agent_machine` and the key from `gcp.ts output --instance-dir "$instance"
  -raw agent_machine_private_key`. Terraform sets `SSH_ALLOWED_PRIVATE_CIDRS`
  to the cluster's subnet (plus `ssh_allowed_private_cidrs`).
- **Back up** the instance directory: `terraform/gcp-celld/celld-install/`
  holds the instance's signing and encryption keys, and updates need them.

## Update

```sh
git -C "$AZAD_SOURCE" pull && bun install --frozen-lockfile --cwd "$AZAD_SOURCE"
bun --no-env-file scripts/gcp.ts refresh --instance-dir "$instance"   # records the new HEAD
bun --no-env-file scripts/gcp.ts init    --instance-dir "$instance"
bun --no-env-file scripts/gcp.ts plan    --instance-dir "$instance" -out=terraform.tfplan
bun --no-env-file scripts/gcp.ts apply   --instance-dir "$instance" terraform.tfplan
```

The deploy waits until the API serves the new revision. To redeploy the same
revision:

```sh
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" \
  -replace='module.app[0].terraform_data.deploy'
```

### Native push for the mobile apps

The iOS and Android apps are woken through Azad's push relay, which needs this
instance claimed by an azad.pro account. A deploy claims relay access when it
has your session and no relay token yet:

```sh
export AZAD_PUSH_RELAY_SESSION_TOKEN='<short-lived azad.pro session token>'
bun --no-env-file scripts/gcp.ts apply --instance-dir "$instance" \
  -replace='module.app[0].terraform_data.deploy'
unset AZAD_PUSH_RELAY_SESSION_TOKEN
```

The relay token is kept in `celld-install/secrets.json` and deployed on every
later update; the session token is never written to a file.

## Remove everything

```sh
bun --no-env-file scripts/gcp.ts destroy --instance-dir "$instance"
```

- **Evaluation installs** are removed completely, including the Clerk
  application the `azad` CLI created (destroy deletes it with
  `npx clerk@4.0.0`, so it needs Node and your Clerk CLI login).
- **Production installs** keep deletion protection on. It protects the
  cluster, the database and the agent machine only: a destroy with it on
  removes everything else first, the Forgejo repositories' disk included,
  then stops with an error. To remove everything, set
  `deletion_protection = false` in the variables and apply before destroying;
  that also deletes the fleet bucket and the disk backups.
- Destroy waits, using `gcloud`, until Kubernetes has deleted the cluster's
  disks. A destroy that stopped after the cluster was gone finishes what is
  left on the next run.
- Cloud SQL reserves a deleted instance's name for up to a week; each install
  appends a random suffix, so you can reinstall at once.

## Troubleshooting

- **The deploy log** is `terraform/gcp-celld/celld-install/install.log` in the
  instance directory (Terraform hides the deploy's output because its input
  holds the database password).
- **The apply stops waiting for the load balancer:** the `A` records are left
  as they were. Check the certificate with `gcloud certificate-manager
  certificates describe <name>-tls --location=<region>` and the Gateway with
  `kubectl -n azad describe gateway azad-regional`, then apply again.
- **The VPC already has a proxy-only subnet in the region:** set
  `proxy_only_subnet_range = null` to use it.
- **Sign-in fails right after install:** Clerk verifies DNS and issues its
  certificate on its own schedule; **Verify** on Clerk's Domains page makes it
  check at once.
