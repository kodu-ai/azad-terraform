# Customer inputs: what is actually necessary

The full reference contains optional application features, not 50 required setup
questions. The recommended `cloudflare.ts setup` flow asks for the **database
provider/region and web hostname**, seven external application credential fields,
and the selected database provider access: Google ADC plus project ID for Cloud
SQL, or an existing direct PostgreSQL connection string.
It generates the remaining configuration. No application requirement was removed.

## Provider selection

Choose `--database-provider cloudsql` with `--project-id` and Google ADC, or
`--database-provider postgres` with `--root postgres`.
The Postgres composition reads `DATABASE_URL` from the selected private file and
passes it as sensitive `TF_VAR_database_url`. No database provisioning provider,
Google credentials or discovered SQL CIDRs are used for that path. Its existing
database account/region and owner credentials are customer choices. Neon works
through its direct endpoint with verified TLS. Its unsupported community Terraform
provider is not used. Clerk account creation remains external to Terraform.

## Required from the customer

| Input | Why it cannot be invented / where it comes from | Secret? |
| --- | --- | --- |
| Google authentication (ADC/workload identity), Cloud SQL only | Authority in the customer's billed GCP project. Use an existing login or identity configuration; there is no `gcp_token` field. | Yes |
| `--project-id` → `gcp.project_id`, Cloud SQL only | Which existing Google project to use, from its console | No |
| `AZAD_SELF_HOST_DATABASE_CA`, for automatic Neon CA registration | `neon-isrg-root-x1`; Terraform registers the OS-trusted public CA and supplies its ID during apply | No |
| `AZAD_SELF_HOST_DATABASE_CA_CERT_ID`, for existing-CA `verify-full` | Existing account-scoped CA ID, mutually exclusive with the automatic selector; direct runner trusts the public chain | No |
| `DATABASE_URL`, existing Postgres only | Direct PostgreSQL schema-owner connection from the database provider; explicit TLS required | Yes |
| `--web-host` | The customer's chosen web hostname, e.g. `board.example.com`; API defaults to `api.board.example.com` | No |
| `CLOUDFLARE_API_TOKEN` | Deployment token restricted to the customer's account/zones, from Cloudflare API Tokens | Yes |
| `CLERK_PUBLISHABLE_KEY` | Existing customer Clerk application → API Keys | No |
| `CLERK_SECRET_KEY` | Same application's secret API key | Yes |
| `CLERK_WEBHOOK_SECRET` | Signing secret of its configured Azad webhook | Yes |
| `GITHUB_APP_ID` | Existing customer GitHub App ID | No |
| `GITHUB_APP_PRIVATE_KEY` | PEM key generated in that App's settings | Yes |
| `GITHUB_APP_CLIENT_SECRET` | OAuth client secret generated in that App's settings | Yes |

The seven fields in [credentials.env.example](credentials.env.example) are the
Cloudflare token, three Clerk fields and three GitHub fields. That private file is
passed by path; do not paste secrets into command-line flags. Optional provider
keys are not necessary for infrastructure/app installation. Agent/model use still
needs a configured machine and provider after installation.

Google needs Cloud SQL management/API enablement (typically
`roles/cloudsql.admin` + `roles/serviceusage.serviceUsageAdmin`). A user ADC quota
project also needs `serviceusage.services.use`, commonly Service Usage Consumer.
The optional [administrator token bootstrap](docs/token-bootstrap.md)
creates the deployment token and optional Mini Apps token from one separately
protected user-token management credential. Existing manually supplied tokens
remain supported. The bootstrap secret never belongs in this credential file.

The Cloudflare deployment token needs Account Settings Read, Workers Scripts
Edit, Workers R2 Storage Edit, Queues Edit, Hyperdrive Edit, Cloudflare Pages Edit,
Workers Routes Edit, Zone Read and DNS Edit. The helper reuses this one selected
token for Terraform and the installer; there is no second token copy/export.

## Derivable: no customer typing

| Input | How it is filled / override |
| --- | --- |
| `cloudflare.account_id` | Read the token's accessible accounts; accept exactly one. If ambiguous, setup asks for `--account-id`. |
| Zone IDs | Installer discovers authoritative zones from the account and hostnames. No Terraform zone ID variable. |
| `cloudflare.web_origin`, `cloudflare.api_origin` | Build HTTPS origins from `--web-host`; change the generated tfvars for a different API hostname before first apply. |
| `gcp.authorized_networks` | Read Cloudflare's published IPv4 ranges plus the setup machine's public IPv4 from Cloudflare trace. Use `--runner-cidr` for direct PostgreSQL TCP egress if apply runs elsewhere, HTTP proxy variables are set, routing differs for TCP, or detection returns IPv6. Review the generated CIDRs. These are shared Cloudflare ranges. |
| `gcp.instance_name` | If omitted, base derives `azad-<12-character API-origin hash>`. Explicit names remain supported, with combined `project_id:instance_name` length <=98. |
| Worker, Pages, R2, queue, Hyperdrive names | Derived from API origin using the existing installer naming contract. No extra name inputs. |
| `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` | Authenticated read of GitHub `/app` using the supplied App ID/private key |
| `deployment.revision` | The `HEAD` of the Azad source checkout (`--source`) during setup. `refresh` updates only this field for later source revisions. |
| `source_dir` | The drivers pass `--source` (or `AZAD_SOURCE`) to Terraform as `TF_VAR_source_dir` on every command that deploys or uninstalls; it is never written to the variables file, so the checkout may move. |
| `DATABASE_URL`, Cloud SQL only | Terraform builds it from provisioned SQL host/database/user/password. Never type it into the setup file. |
| Installer `CLOUDFLARE_ACCOUNT_ID`, `AZAD_SELF_HOST_API_ORIGIN`, `AZAD_SELF_HOST_WEB_ORIGIN`, `AZAD_SELF_HOST_STATE_DIR` | The deploy handoff (`modules/installation`) fills them from Terraform inputs and outputs; duplicate values in the private dotenv are overridden. |
| `V3_CF_ACCOUNT_ID` | Setup copies the selected Cloudflare account when a Mini App runtime token or managed Artifacts token is supplied. |

Setup reads account/app metadata and public network information. It creates no
cloud resources and does not run Terraform. It requires network access for those
lookups; it does not silently guess when account/IP discovery is ambiguous.

## Generated: retained, not re-entered

| Input | Owner / retention |
| --- | --- |
| `database_password`, Cloud SQL only | Terraform `random_password` creates a 32-character password when omitted and retains it in state. An explicit sensitive override remains available for imports/existing users. Keep that override until deliberately rotating it. |
| `GITHUB_WEBHOOK_SECRET` | Setup preserves an existing supplied value, or generates it once into the private installer file. Copy the generated value into GitHub App webhook settings before apply. Setup does not modify the GitHub App. |
| `REALTIME_UPGRADE_SECRET`, `MEDIA_CAPABILITY_SECRET`, `INTERNAL_API_SECRET`, `AGENT_TASK_SECRET_CIPHER_KEY`, `VAPID_PRIVATE_JWK`, `MINIAPP_TOKEN_PRIVATE_JWK`, release signing key | Existing installer generates them and preserves them in its state directory. Back up that directory. |

Terraform passwords/DSNs, including generated ones, remain in state and saved
plans. Choose a customer-controlled backend before real use. The private installer
file contains external keys and the generated GitHub webhook secret. The helper
writes it with mode 0600 and refuses to overwrite existing setup files, so reruns
cannot silently rotate the webhook or discard customer overrides.

## Defaultable: infrastructure and file locations

| Input | Default; override only when needed |
| --- | --- |
| `gcp.region` | `me-central2` (Dammam); review customer access before apply |
| `gcp.tier`, `gcp.availability_type` | `db-custom-2-7680` (2 vCPU / 7.5 GiB), `ZONAL` |
| `gcp.disk_size_gb`, `gcp.deletion_protection` | `20`, `true` |
| `gcp.database_name`, `gcp.username`, `gcp.labels` | `azad`, `azad`, `{}` |
| `deployment.env_file`, `deployment.state_directory` | Setup writes the instance directory's `.env` and `terraform/<root name>/installer-state` as absolute paths; the drivers refuse relative paths or paths inside this repository. Terraform's own defaults (`.env.self-host`, `.installer-state`, relative to the root) apply only to plain `terraform` runs. |
| `deployment.enabled` | `true`; `false` is infrastructure only |
| `storage` | `{ adapter = "r2" }`: this installation's two R2 buckets. Setup derives `{ adapter = "s3" \| "gcs", bucket, releases_bucket?, endpoint?, region? }` from `STORAGE_*` in the credential file to use your own bucket instead; no R2 bucket is then created or bound, and Agent Connect releases share the bucket unless `releases_bucket` names another. `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` stay in the private installer file. |
| `host_zones` | Setup resolves the zone of the web and API hosts. Terraform reserves both hosts from zone-wide Workers routes with hostname routes that run no Worker; `{}` reserves nothing. |
| `github_app_pending` | `false`. Setup sets `true` from `AZAD_SELF_HOST_GITHUB_APP_PENDING=1`: deploy before the GitHub App exists. Only GitHub's App identity check is skipped; the `GITHUB_APP_*` placeholders are deployed, GitHub sign-in/repositories/webhooks fail, and the `github_app` output and installer summary say PENDING until the real App replaces them. |
| `AZAD_SELF_HOST_MINIAPPS` | Setup explicitly writes `disabled` when no runtime token was supplied. To enable Mini Apps, supply `V3_CF_API_TOKEN` (Workers Scripts Edit + D1 Edit in the same account); setup derives its account ID. |

For Cloud SQL, Postgres17, SSD/autogrowth, backups/PITR and encrypted public connections are fixed
module settings. Region is a default to review, not something inferred from the
authenticated Google identity. The reusable modules still accept advanced overrides.

## Defaultable: optional features, off unless supplied

These are advanced overrides in the private credential file, not setup questions. Empty or omitted optional feature
settings remove that configured value on the next installer run. “Unset” below
means the installer supplies no value; the application's own fallback can apply.

| Variable(s) | Default / purpose / source | Secret? |
| --- | --- | --- |
| `AZAD_SELF_HOST_ENV` | `production`; persistent installer identity label chosen by operator | No |
| `AZAD_INSTANCE_NAME` | `Azad`; customer display name | No |
| `AZAD_INSTANCE_EMOJI`, `AZAD_INSTANCE_IMAGE_URL` | Unset; optional branding chosen by customer | No |
| `AZAD_SELF_HOST_PLACEMENT_REGION` | Unset; optional Cloudflare placement hint, not data residency | No |
| `VAPID_SUBJECT` | `mailto:admin@<web-host>`; customer contact | No |
| `AZAD_AGENT_RELEASE_SOURCE` | `https://api.azad.pro`; trusted Agent Connect release source | No |
| `PUSH_RELAY_URL` | `https://push.azad.pro`; native push needs a separate relay claim | No |
| `RESEND_API_KEY` | Unset; Resend dashboard key for email, paired with `EMAIL_FROM` | **Yes** |
| `EMAIL_FROM`, `RESEND_DOMAIN` | Unset; verified sender and optional domain metadata from customer Resend setup | No |
| `SENTRY_DSN` | Unset; Sentry project client-ingestion DSN, optional error reporting | Not an admin credential; keep in selected configuration |
| `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Unset; operator label and rate from 0 to 1. The example chooses `production` and `0`. | No |
| `CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID`, `CLOUDFLARE_REALTIMEKIT_APP_ID` | Unset; customer RealtimeKit account/app IDs; configure both with its token | No |
| `CLOUDFLARE_REALTIMEKIT_API_TOKEN` | Unset; RealtimeKit token from Cloudflare for that app. The installer (and `azad --provision-meetings`) creates the app and a token with only the account's Realtime permission | **Yes** |
| `CLOUDFLARE_REALTIMEKIT_PRESET_NAME`, `CLOUDFLARE_REALTIMEKIT_PARTICIPANT_PRESET_NAME`, `CLOUDFLARE_REALTIMEKIT_VOICE_PRESET_NAME`, `CLOUDFLARE_REALTIMEKIT_VOICE_PARTICIPANT_PRESET_NAME` | Unset; preset names created in the customer's RealtimeKit app for the desired meeting roles | No |
| `OPENAI_API_KEY` | Unset; OpenAI project key for optional meeting/title functionality | **Yes** |
| `OPENAI_MEETING_TITLE_MODEL` | Unset; optional model selection | No |
| `KLIPY_API_KEY` | Unset; optional GIF provider key from Klipy | **Yes** |
| `AZAD_HOSTED_MEDIA_PROJECT_ID` | Unset; optional existing Azad project that funds hosted media. Without it, each project funds its own. | No |

Normal agent/model usage still needs a machine and project model/provider setup
after installation. The optional keys above do not provision those machines.

The installer generates and preserves
`REALTIME_UPGRADE_SECRET`, `MEDIA_CAPABILITY_SECRET`, `INTERNAL_API_SECRET`,
`AGENT_TASK_SECRET_CIPHER_KEY`, `VAPID_PRIVATE_JWK`, `MINIAPP_TOKEN_PRIVATE_JWK`
and the Agent Connect release signing key. Customers do not generate these inputs;
they must retain/back up the installer state directory.

## Outside Terraform: actual onboarding actions

The customer still needs billing/region access, Cloudflare service entitlements
(Workers Paid, R2, Queues, Hyperdrive, Pages, DO and Worker Loader), and DNS zones
delegated to the selected Cloudflare account. Choose/provision the state backend.

Create/configure the existing Clerk application and GitHub App using the
[self-host instructions](https://github.com/kodu-ai/azad-ide-web/blob/main/docs/self-hosting.md#clerk-application): production DNS,
allowed origins, OAuth callbacks, App installation/permissions and webhooks. The
helper cannot generate valid external app credentials or consent. Its generated
GitHub webhook secret must be entered in the App settings. Finish first-use
acceptance and machine/provider setup after deployment.

## Removable from the setup checklist

For Cloud SQL, do not ask customers for generated database passwords. Existing
Postgres still needs its owner DSN. Do not ask for internal encryption keys, duplicate
account/origin values, resource names, source revisions, state paths, zone IDs or
optional feature keys when defaults/derivation above handle them. No app credential
has been removed from the runtime merely to shorten the checklist.

## Managed project source: now supported by the installer

For a complete managed-source installation, supply these runtime settings in the
private credential file (separate from Terraform provider tokens):

| Input | Source / behavior |
| --- | --- |
| `CLOUDFLARE_ARTIFACTS_API_TOKEN` | Customer account credential with Artifacts Read/Edit |
| `V3_CF_ARTIFACTS_NAMESPACE` | Existing namespace chosen/created by the customer with its intended residency |
| `CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN` | Customer account credential permitting event subscription management |
| `V3_CONTROL_BACKUP_GITHUB_REPO` | Existing private `owner/repository`, installed for the customer's GitHub App |
| `V3_CF_ACCOUNT_ID` | Derived by setup, shared with the selected Cloudflare account |
| `V3_CF_ARTIFACTS_EVENT_QUEUE_ID` | Derived by the installer from its consumed queue. A supplied different ID is rejected. |
| `V3_CONTROL_VALIDATION_GITHUB_REPO`, `V3_CONTROL_VALIDATION_PROJECT_ID` | Optional pair for a trusted operator project's validation workflow; no arbitrary customer project gains operator CI authority |

Incomplete managed configuration is rejected before deployment. These settings now
reach Worker secrets. The application creates project repositories and their push
subscriptions at runtime. Terraform does not create a second owner for those.
Without the settings, setup explicitly reports managed source as unconfigured.
Mini Apps still require their runtime token; disabling them is a reduced-feature
install, not full product acceptance. Agent/model setup, invitations, repository
attachment and external webhook delivery must be exercised during live acceptance.
The retired fallback-Admin keys and unsupported `SENTRY_AGENT_TRACES_SAMPLE_RATE`
are not customer setup inputs.
