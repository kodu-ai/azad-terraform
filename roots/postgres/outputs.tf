output "cloudflare_resources" {
  description = "Fixed resources owned by Terraform."
  value       = module.base.cloudflare_resources
}

output "origins" {
  description = "Requested URLs; available only after the installer successfully deploys and verifies."
  value = {
    api = var.cloudflare.api_origin
    web = var.cloudflare.web_origin
  }
}

output "storage" {
  description = "Object storage selection: this installation's R2 buckets (adapter r2) or the operator's own bucket."
  value       = module.base.storage
}

output "github_app" {
  description = "GitHub App status of the deployment. PENDING: the deployed GITHUB_APP_* values are unverified placeholders."
  value       = var.github_app_pending ? "PENDING: GitHub App verification was deferred (github_app_pending = true). GitHub sign-in, repositories and webhooks do not work until you register the GitHub App, put its values in the installer file, set github_app_pending = false and apply again." : "verified by the installer preflight"
}

output "database_ca_certificate_id" {
  description = "Terraform-owned public CA ID, or null for existing CA reuse."
  value       = module.base.database_ca_certificate_id
}
