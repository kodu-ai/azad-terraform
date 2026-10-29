# Test fixture: what a customer already owns before installing Azad on
# Cloudflare with their own PostgreSQL and S3-compatible storage. It is not part
# of an Azad installation and is never destroyed by one.

# Hyperdrive connects from Cloudflare's published ranges; migrations connect
# from the runner. Cloud SQL accepts only these sources, over TLS.
data "http" "cloudflare_ipv4" {
  url = "https://www.cloudflare.com/ips-v4"
}

data "http" "runner" {
  count = var.runner_cidr == "" ? 1 : 0
  url   = "https://www.cloudflare.com/cdn-cgi/trace"
}

locals {
  cloudflare_ranges = compact(split("\n", trimspace(data.http.cloudflare_ipv4.response_body)))
  runner_ip         = var.runner_cidr != "" ? var.runner_cidr : "${one(regex("(?m)^ip=([0-9.]+)$", data.http.runner[0].response_body))}/32"
  authorized_networks = merge(
    { for index, cidr in local.cloudflare_ranges : "cloudflare-${index + 1}" => cidr },
    { runner = local.runner_ip },
  )
}

resource "random_password" "database" {
  length  = 32
  special = false
}

module "postgres" {
  source = "../../modules/gcp/cloud-sql"

  settings = {
    project_id          = var.project_id
    region              = var.region
    instance_name       = "${var.name_prefix}-postgres"
    tier                = "db-f1-micro"
    disk_size_gb        = 10
    deletion_protection = false
    backups             = false
    authorized_networks = local.authorized_networks
    labels              = { purpose = "azad-byo-fixture" }
    # Hyperdrive pools up to 20 origin connections beside the migration
    # runner; the shared-core default (25) leaves too few.
    database_flags = {
      max_locks_per_transaction = "1024"
      max_connections           = "100"
    }
  }
  password = random_password.database.result
}

resource "google_project_service" "storage" {
  for_each = toset(["storage.googleapis.com", "iam.googleapis.com"])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_storage_bucket" "files" {
  project                     = var.project_id
  name                        = "${var.name_prefix}-${var.project_id}-files"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels                      = { purpose = "azad-byo-fixture" }

  depends_on = [google_project_service.storage]
}

resource "google_service_account" "storage" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-storage"
  display_name = "Azad BYO storage fixture"

  depends_on = [google_project_service.storage]
}

resource "google_storage_bucket_iam_member" "storage" {
  bucket = google_storage_bucket.files.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.storage.member
}

# S3-compatible (XML API) credentials for the API's gcs storage adapter.
resource "google_storage_hmac_key" "storage" {
  project               = var.project_id
  service_account_email = google_service_account.storage.email

  depends_on = [google_storage_bucket_iam_member.storage]
}

resource "local_sensitive_file" "customer_env" {
  filename        = pathexpand(var.env_file)
  file_permission = "0600"
  content         = <<-EOT
    DATABASE_URL=${module.postgres.database_url}
    STORAGE_ADAPTER=gcs
    STORAGE_BUCKET=${google_storage_bucket.files.name}
    STORAGE_ACCESS_KEY_ID=${google_storage_hmac_key.storage.access_id}
    STORAGE_SECRET_ACCESS_KEY=${google_storage_hmac_key.storage.secret}
  EOT
}
