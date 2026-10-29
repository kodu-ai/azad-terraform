# Stable across ordinary applies. An existing installation can supply its password
# instead; do not remove that override without deliberately rotating credentials.
resource "random_password" "database" {
  count   = nonsensitive(var.database_password == null) ? 1 : 0
  length  = 32
  special = false
}

module "database" {
  source = "../gcp/cloud-sql"

  settings = merge(var.gcp, {
    instance_name = coalesce(var.gcp.instance_name, "azad-${substr(sha256(var.cloudflare.api_origin), 0, 12)}")
  })
  password = var.database_password == null ? random_password.database[0].result : var.database_password
}

module "cloudflare" {
  source = "../cloudflare/resources"

  account_id = var.cloudflare.account_id
  api_origin = var.cloudflare.api_origin
  r2_buckets = var.storage.adapter == "r2"
}

module "installation" {
  source          = "../installation"
  cloudflare      = var.cloudflare
  deployment      = var.deployment
  source_dir      = var.source_dir
  resource_prefix = module.cloudflare.resource_prefix
  resources       = module.cloudflare.resources
  database_url    = module.database.database_url
  storage         = var.storage

  github_app_pending = var.github_app_pending
  # Clerk's records precede the installer, which waits for Clerk's domain.
  depends_on = [module.database, module.cloudflare, module.clerk_dns, module.host_routes]
}

module "clerk_dns" {
  source = "../cloudflare/clerk-dns"
  count  = var.clerk_dns == null ? 0 : 1

  zone_id = try(var.clerk_dns.zone_id, "")
  records = try(var.clerk_dns.records, {})
}

module "host_routes" {
  source = "../cloudflare/host-routes"
  count  = length(var.host_zones) == 0 ? 0 : 1

  hosts = var.host_zones
}
