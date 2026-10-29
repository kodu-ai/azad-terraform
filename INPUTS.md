# Inputs

Everything an installation needs, where it lives and who fills it in. The
[README](README.md) has the short version; this is the full list.

## Where each input lives

| Place | What goes there | Who writes it |
| --- | --- | --- |
| Your shell | `AZAD_SOURCE`, Google credentials, proxy settings | You |
| `<instance>/.env` (mode 0600) | Credentials and app settings. Setup reads it, the drivers take `CLOUDFLARE_API_TOKEN` and `DATABASE_URL` from it, and the deploy reads all of it | You, plus a few keys setup adds |
| `<instance>/terraform/<root>/terraform.tfvars.json` | Non-secret Terraform variables | Setup writes it once; you edit it afterwards |
| Terraform state, `installer-state/`, `celld-install/` | Generated passwords, keys and the deploy's own state | Terraform and the deploy |

`<instance>` is the directory you pass as `--instance-dir`, for example
`~/.azad/instances/default`. `<root>` is `postgres`, `cloudsql` or `gcp-celld`.

## Your shell

| Name | Needed for | What it does |
| --- | --- | --- |
| `AZAD_SOURCE` | `setup`, `refresh`, `plan`, `apply`, `destroy`, unless you pass `--source` | Path of the Azad app checkout (a clone of `kodu-ai/azad-ide-web` with `bun install` done). The drivers check that it is the checkout's top level with the `scripts/self-host` entrypoints and installed dependencies, and bind the deploy to its `HEAD`. Read-only commands (`init`, `output`, `show`, `state`, `phase`) don't need it. |
| Google Application Default Credentials | `cloudsql` and `gcp-celld` | `gcloud auth application-default login` (or `GOOGLE_APPLICATION_CREDENTIALS`). Terraform's Google provider and the Google Cloud deploy use them. |
| `gcloud` signed in | `gcp-celld` | `gcloud auth login`. Destroy uses the gcloud CLI to wait for the cluster's disks and, for an evaluation install, to delete its backups. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` | `cloudsql` setup | When one is set, setup can't see your direct egress address and asks for `--runner-cidr`. |
| `TF_VAR_database_password` | Optional, `cloudsql` | Use this Cloud SQL password instead of a generated one, for example when adopting an existing user. Keep it set until you rotate on purpose. |
| `AZAD_PUSH_RELAY_SESSION_TOKEN` | Optional, `gcp-celld` | A short-lived azad.pro session token that lets one deploy claim native push access ([docs/google-cloud.md](docs/google-cloud.md#native-push-for-the-mobile-apps)). Never written to a file. |

`CLOUDFLARE_API_TOKEN` does **not** come from your shell: the drivers read it
from the instance's `.env` and hand it to Terraform, overriding any exported
value.

The drivers also set these for Terraform; you never set them yourself:
`TF_DATA_DIR` (the instance's `.terraform/`), `TF_VAR_source_dir` (from
`--source`), `TF_VAR_database_url` (from `DATABASE_URL` in the `.env`) and
`TF_VAR_database_ca_pem` (ISRG Root X1 from this machine's trust store, only
with `database_ca`).

## The instance `.env`

Start from [credentials.env.example](credentials.env.example). Values are
dotenv strings; a multi-line PEM key goes in double quotes with `\n` for each
newline. Keep the file private (`chmod 600`). Setup never replaces it; it only
adds the keys marked "setup adds" below.

### Cloudflare (`postgres` and `cloudsql` roots)

| Key | Required? | What it's for | Example |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Yes | Terraform and the deploy ([permissions](#the-cloudflare-api-token)) | |
| `CLERK_PUBLISHABLE_KEY` | Yes | Your Clerk application | `pk_live_…` |
| `CLERK_SECRET_KEY` | Yes | Same application. With a live key, setup reads Clerk's DNS targets so Terraform can add them | `sk_live_…` |
| `CLERK_WEBHOOK_SECRET` | Yes | Signing secret of the Clerk webhook to `https://api.<web-host>/api/clerk/webhooks` | `whsec_…` |
| `GITHUB_APP_ID` | Yes | Your GitHub App | `123456` |
| `GITHUB_APP_PRIVATE_KEY` | Yes | A private key generated in the App's settings | `"-----BEGIN RSA PRIVATE KEY-----\n…"` |
| `GITHUB_APP_CLIENT_SECRET` | Yes | A client secret generated in the App's settings | |
| `DATABASE_URL` | `postgres` root only | Direct (not pooled) connection as the schema owner, PostgreSQL 17 or newer, with exactly one query option: `sslmode=require` or `sslmode=verify-full` | `postgresql://azad:…@ep-x-123.eu-central-1.aws.neon.tech/azad?sslmode=verify-full` |
| `AZAD_SELF_HOST_DATABASE_CA` | With `verify-full` on a Neon direct endpoint (or the next key) | `neon-isrg-root-x1`: Terraform registers Neon's public CA, taken from this machine's OS trust store, so Hyperdrive verifies the database | `neon-isrg-root-x1` |
| `AZAD_SELF_HOST_DATABASE_CA_CERT_ID` | With `verify-full` otherwise | ID of a CA certificate already uploaded to your Cloudflare account; not together with the previous key | |
| `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` | No: setup adds them | Read from GitHub with the App's key | `my-azad`, `Iv23li…` |
| `GITHUB_WEBHOOK_SECRET` | No: setup adds one | Kept if present, generated otherwise. Copy it into the App's webhook settings | 64 hex characters |
| `AZAD_SELF_HOST_MINIAPPS` | No: setup adds it | `enabled` with `V3_CF_API_TOKEN`, `disabled` without | `disabled` |
| `V3_CF_API_TOKEN` | No | Turns on Mini Apps: Workers Scripts Edit and D1 Edit in the same account. Setup then adds `V3_CF_ACCOUNT_ID` | |
| `STORAGE_ADAPTER`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | No | Your own bucket instead of R2: `gcs` (HMAC keys) or `s3`. `s3` also needs `STORAGE_REGION`, and `STORAGE_ENDPOINT` outside AWS. `STORAGE_RELEASES_BUCKET` puts Agent Connect releases in a second bucket | `gcs`, `my-azad-files` |
| `AZAD_SELF_HOST_GITHUB_APP_PENDING` | No | `1` deploys before the GitHub App exists. Put placeholders in every `GITHUB_APP_*` key, including the slug and client ID; GitHub features stay off until you replace them, set `github_app_pending` to `false` and apply | `1` |

`CLOUDFLARE_ACCOUNT_ID`, `AZAD_SELF_HOST_API_ORIGIN`,
`AZAD_SELF_HOST_WEB_ORIGIN` and `AZAD_SELF_HOST_STATE_DIR` come from Terraform
during the deploy; values in the `.env` are overridden.

### Google Cloud (`gcp-celld` root)

| Key | Required? | What it's for | Example |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Yes | DNS records (and, with `cloudflare_proxy`, certificates) in your zone ([permissions](#the-cloudflare-api-token)) | |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Yes | Your Clerk application; both live or both test keys | `pk_live_…`, `sk_live_…` |
| `CLERK_WEBHOOK_SECRET` | No | Until it is set, users sync on sign-in only | `whsec_…` |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` | All five or none | Your GitHub App. Without it, repository features are off | |
| `GITHUB_WEBHOOK_SECRET` | No | Generated into `celld-install/secrets.json` when missing; copy it into the App's webhook settings | |
| `AZAD_CLI_CLERK_APP_ID` | No | Written by the `azad` CLI when it created the Clerk application. Setup records it, and an `--evaluation` install deletes that application on destroy | `app_…` |

Managed project repositories on Google Cloud live in the installation's own
Forgejo, which Terraform sets up; Cloudflare Artifacts settings are ignored
there.

### Optional features

Leave these out unless you want the feature. On Cloudflare, an empty or
missing value removes a setting a previous deploy had.

| Key | Default and purpose | Secret? |
| --- | --- | --- |
| `AZAD_INSTANCE_NAME` | `Azad`; the name people see | No |
| `AZAD_INSTANCE_EMOJI`, `AZAD_INSTANCE_IMAGE_URL` | Unset; branding | No |
| `VAPID_SUBJECT` | `mailto:admin@<web-host>` on Cloudflare; a `mailto:` or `https:` contact for web push | No |
| `PUSH_RELAY_URL` | `https://push.azad.pro`; native push relay | No |
| `AZAD_AGENT_RELEASE_SOURCE` | `https://api.azad.pro`; where Agent Connect releases are mirrored from | No |
| `RESEND_API_KEY` with `EMAIL_FROM` (and optional `RESEND_DOMAIN`) | Unset; email through Resend | **Yes** (the key) |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Unset; error reporting (rate from 0 to 1) | No |
| `CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID`, `CLOUDFLARE_REALTIMEKIT_APP_ID`, `CLOUDFLARE_REALTIMEKIT_API_TOKEN` | Unset; meetings. All three together; the `azad` CLI can create the app and a Realtime-only token (`azad --provision-meetings`) | **Yes** (the token) |
| `CLOUDFLARE_REALTIMEKIT_PRESET_NAME`, `CLOUDFLARE_REALTIMEKIT_PARTICIPANT_PRESET_NAME`, `CLOUDFLARE_REALTIMEKIT_VOICE_PRESET_NAME`, `CLOUDFLARE_REALTIMEKIT_VOICE_PARTICIPANT_PRESET_NAME` | Unset; preset names in that RealtimeKit app | No |
| `OPENAI_API_KEY`, `OPENAI_MEETING_TITLE_MODEL` | Unset; meeting titles | **Yes** (the key) |
| `KLIPY_API_KEY` | Unset; GIF search | **Yes** |
| `AZAD_HOSTED_MEDIA_PROJECT_ID` | Unset; an Azad project that pays for every project's transcription and speech. Unset: each project pays for its own | No |
| `SSH_ALLOWED_PRIVATE_CIDRS` | Unset; private networks the API may SSH into (comma-separated). On Google Cloud, Terraform sets it from the cluster's subnet plus `ssh_allowed_private_cidrs` | No |
| `AZAD_SELF_HOST_ENV` | `production`; Cloudflare installer label (lowercase, up to 32 characters) | No |
| `AZAD_SELF_HOST_PLACEMENT_REGION` | Unset; Cloudflare placement hint, not data residency | No |

Managed project source on Cloudflare (Cloudflare Artifacts) needs
`CLOUDFLARE_ARTIFACTS_API_TOKEN` (Artifacts Read and Edit) and
`CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN` (event subscriptions). Setup then adds
`V3_CF_ACCOUNT_ID`, a namespace of this installation's own
(`V3_CF_ARTIFACTS_NAMESPACE`, unless you set one) and, without
`V3_CONTROL_BACKUP_GITHUB_REPO` (a private `owner/repository` your App can
reach), `V3_CONTROL_BACKUP=none`. `V3_CONTROL_VALIDATION_GITHUB_REPO` and
`V3_CONTROL_VALIDATION_PROJECT_ID` go together. Never copy another
installation's `V3_CF_ARTIFACTS_EVENT_QUEUE_ID`: the deploy derives it.

The `azad` CLI keeps its own answers in the same file as `AZAD_CLI_*` keys.
Changing them doesn't redeploy.

## `terraform.tfvars.json`

Setup writes it once from your flags and refuses to overwrite it. To change a
setting later, edit the file, then `plan` and `apply`. `refresh` changes only
`deployment.revision`.

### `postgres` and `cloudsql`

| Field | Required? | What it's for | Default or example |
| --- | --- | --- | --- |
| `cloudflare.account_id` | Yes (setup) | Your Cloudflare account: the token's only one, or `--account-id` | 32 hex characters |
| `cloudflare.web_origin`, `cloudflare.api_origin` | Yes (setup) | `https://<web-host>` and `https://api.<web-host>`. The API origin also fixes every resource name, so change it only before the first apply | `https://board.example.com` |
| `deployment.revision` | Yes (setup) | The app commit to deploy: the checkout's `HEAD` | 40 hex characters |
| `deployment.env_file`, `deployment.state_directory` | Yes (setup) | Absolute paths of the `.env` and `installer-state/` in the instance. The drivers refuse relative paths and paths inside this repository | |
| `deployment.enabled` | No | `false` keeps the infrastructure and uninstalls the app | `true` |
| `host_zones` | No (setup) | Zone ID of each hostname; Terraform reserves both from zone-wide Workers routes | `{}` reserves nothing |
| `clerk_dns` | No (setup) | Clerk's production CNAMEs that DNS still lacks | `null` |
| `storage` | No (setup, from `STORAGE_*`) | Your own bucket instead of R2: `adapter` (`s3` or `gcs`), `bucket`, and optionally `releases_bucket`, `endpoint`, `region` | `{"adapter": "r2"}` |
| `github_app_pending` | No (setup, from `AZAD_SELF_HOST_GITHUB_APP_PENDING`) | Deploy before the GitHub App exists | `false` |
| `database_ca` | No, `postgres` only (setup, from `AZAD_SELF_HOST_DATABASE_CA`) | Register Neon's public CA in Cloudflare | `null` |
| `gcp.project_id` | `cloudsql` (setup, from `--project-id`) | Your Google Cloud project | `my-project` |
| `gcp.authorized_networks` | `cloudsql` (setup) | Cloudflare's published IPv4 ranges and your apply machine's IPv4 (`--runner-cidr` overrides it). A snapshot: review it | `{"runner": "198.51.100.10/32", …}` |
| `gcp.region` | No, `cloudsql` | Where Cloud SQL lives. **Setup doesn't write it**: add it before the first apply | `me-central2` |
| `gcp.tier`, `gcp.availability_type`, `gcp.disk_size_gb` | No, `cloudsql` | Size of the database | `db-custom-2-7680`, `ZONAL`, `20` |
| `gcp.deletion_protection` | No, `cloudsql` | Stops Terraform from deleting the database | `true` |
| `gcp.database_name`, `gcp.username`, `gcp.instance_name`, `gcp.labels` | No, `cloudsql` | Names and labels; the instance is `azad-<hash of the API origin>` unless named | `azad`, `azad` |

Cloud SQL always runs PostgreSQL 17 on SSD with a growing disk, backups and
point-in-time recovery, and accepts only encrypted connections.

### `gcp-celld`

| Field | Required? | What it's for | Default or example |
| --- | --- | --- | --- |
| `project_id`, `region` | Yes (setup) | Your Google Cloud project and region | `my-project`, `europe-west1` |
| `web_host` | Yes (setup) | The browser hostname; the API is `api.<web_host>` and Mini Apps `<app>.apps.<web_host>` | `azad.example.com` |
| `name` | Yes (setup) | Prefix of every Google resource, derived from the hostname | `azad-azad-1a2b` |
| `cloudflare_zone_id` | Yes (setup) | The Cloudflare zone of the hostnames | 32 hex characters |
| `deployment` | Yes (setup) | `revision`, `env_file` and `state_directory` (`celld-install/` in the instance) | |
| `deletion_protection` | No | Protects the cluster, database and agent machine. `false` also lets destroy delete the fleet bucket and the disk backups | `true` (`false` with `--evaluation`) |
| `spot` | No | Spot nodes: cheaper, preemptible | `false` (`true` with `--evaluation`) |
| `database` | No | `tier`, `disk_size_gb`, `backups`, `flags` | `db-custom-1-3840`, 10 GB, backups on |
| `api_replicas` | No | API fleet nodes | `2` |
| `disk_backups` | No (setup, `--disk-backups`) | Backup for GKE `schedule` (`hourly`, `daily`, `weekly`, `off`) and `retain_days` | `daily`, 7 days |
| `agent_machine` | No (setup, `--agent-machine`) | `machine_type`, `label` and `disk_size_gb` of a VM for agents | none |
| `clerk_dns` | No (setup) | Clerk's production CNAMEs that DNS still lacks | `null` |
| `clerk_application` | No (setup) | The Clerk application an evaluation install deletes on destroy | `null` |
| `cloudflare_proxy`, `manage_ssl_rule` | No | Proxy the hostnames through Cloudflare with an Origin CA certificate | `false`, `true` |
| `proxy_only_subnet_range` | No | The load balancer's proxy-only subnet; `null` to share the region's existing one | `10.127.0.0/23` |
| `ready_timeout_minutes` | No | How long DNS and deploys wait for the load balancer and the new revision | `45` |
| `ssh_allowed_private_cidrs` | No | More private networks the API may SSH into | `[]` |

[docs/google-cloud.md](docs/google-cloud.md) explains these in context.

## The Cloudflare API token

Cloudflare's dashboard calls the API's "Write" permissions "Edit".

- **Azad on Cloudflare:** Account: Account Settings Read, Workers Scripts
  Edit, Workers R2 Storage Edit, Queues Edit, Hyperdrive Edit and Cloudflare
  Pages Edit. Zone (the zones of your hostnames): Zone Read, DNS Edit and
  Workers Routes Edit. With `sslmode=verify-full`, also Account: SSL and
  Certificates Read for an existing CA ID, or Edit for
  `AZAD_SELF_HOST_DATABASE_CA=neon-isrg-root-x1`.
- **Azad on Google Cloud:** Zone: Zone Read, DNS Edit, SSL and Certificates
  Edit and Config Settings Edit. The last two are used only with
  `cloudflare_proxy`.

[docs/token-bootstrap.md](docs/token-bootstrap.md) mints exactly these from a
token that can create tokens.

## Google Cloud permissions

- **`cloudsql`:** Cloud SQL Admin and Service Usage Admin in the project
  (`roles/cloudsql.admin`, `roles/serviceusage.serviceUsageAdmin`). A user
  ADC's quota project also needs `serviceusage.services.use` (Service Usage
  Consumer).
- **`gcp-celld`:** Owner, or Editor plus Project IAM Admin. Terraform turns on
  the Google APIs it uses (Compute, GKE, Cloud Storage, Cloud SQL Admin,
  Certificate Manager, Backup for GKE).

## Generated for you

You never type these. Back them up with the instance directory.

| What | Where it's kept |
| --- | --- |
| Cloud SQL password | Terraform state. On `cloudsql`, `TF_VAR_database_password` can replace it |
| Forgejo service password, agent machine SSH keys, Origin CA key (`gcp-celld`) | Terraform state |
| `GITHUB_WEBHOOK_SECRET` when you supply none | Cloudflare: the `.env`. Google Cloud: `celld-install/secrets.json` |
| The app's own secrets (`REALTIME_UPGRADE_SECRET`, `MEDIA_CAPABILITY_SECRET`, `INTERNAL_API_SECRET`, `AGENT_TASK_SECRET_CIPHER_KEY`, `VAPID_PRIVATE_JWK`, `MINIAPP_TOKEN_PRIVATE_JWK`, the release signing key) | `installer-state/` (Cloudflare) or `celld-install/` (Google Cloud). They decrypt the data in your database: never delete them to retry a deploy |

Terraform state and saved plans are sensitive. Cloud SQL's DSN and password
are in both; an existing database's `DATABASE_URL` is only in saved plans,
because a plan records its variables.

## Outside Terraform

A few things only you can do:

- Billing and quota in your accounts. For Azad on Cloudflare, Workers Paid
  with R2, Queues, Hyperdrive, Pages, Durable Objects and Worker Loaders (and
  D1 for Mini Apps).
- Your domain's zone in your Cloudflare account.
- The Clerk application and GitHub App: production domain, allowed origins,
  OAuth callbacks, webhooks, the App's permissions and installation. The
  [self-hosting guide](https://github.com/kodu-ai/azad-ide-web/blob/main/docs/self-hosting.md#clerk-application)
  has the details. The URLs, with `api.<web-host>` as the API:
  - Clerk webhook: `https://api.<web-host>/api/clerk/webhooks`
  - GitHub App callback URL and setup URL: `https://api.<web-host>/api/github/install/callback`
  - GitHub App webhook: `https://api.<web-host>/api/github/webhooks`
- After the deploy: sign in, pair an agent machine and set up a model
  provider in a project.
