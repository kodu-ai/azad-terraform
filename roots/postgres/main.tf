module "base" {
  source             = "../../modules/base-postgres"
  database_url       = var.database_url
  database_ca        = var.database_ca
  database_ca_pem    = var.database_ca_pem
  cloudflare         = var.cloudflare
  deployment         = var.deployment
  source_dir         = var.source_dir
  storage            = var.storage
  github_app_pending = var.github_app_pending
  host_zones         = var.host_zones
  clerk_dns          = var.clerk_dns
}
