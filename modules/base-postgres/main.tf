module "cloudflare" {
  source           = "../cloudflare/resources"
  account_id       = var.cloudflare.account_id
  api_origin       = var.cloudflare.api_origin
  register_neon_ca = var.database_ca == "neon-isrg-root-x1"
  database_ca_pem  = var.database_ca_pem
  r2_buckets       = var.storage.adapter == "r2"
}

# Clerk's production domain must resolve (and Clerk must issue its
# certificate) before the installer's preflight reads the Frontend API, so the
# installation waits for these records; the installer then waits for Clerk.
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

module "installation" {
  source                     = "../installation"
  cloudflare                 = var.cloudflare
  deployment                 = var.deployment
  source_dir                 = var.source_dir
  resource_prefix            = module.cloudflare.resource_prefix
  resources                  = module.cloudflare.resources
  database_url               = var.database_url
  database_ca_certificate_id = module.cloudflare.database_ca_certificate_id
  storage                    = var.storage
  github_app_pending         = var.github_app_pending
  depends_on                 = [module.cloudflare, module.clerk_dns, module.host_routes]
}
