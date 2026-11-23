module "base" {
  source = "../../modules/base"

  gcp                = var.gcp
  database_password  = var.database_password
  cloudflare         = var.cloudflare
  deployment         = var.deployment
  release_dir        = var.release_dir
  storage            = var.storage
  github_app_pending = var.github_app_pending
  host_zones         = var.host_zones
  clerk_dns          = var.clerk_dns
  updater_image      = var.updater_image

  miniapp_base_domain = var.miniapp_base_domain
}
