output "cloudflare_resources" {
  description = "Fixed resources owned by Terraform."
  value       = module.cloudflare.resources
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
  value       = var.storage
}

output "database_ca_certificate_id" {
  description = "Terraform-owned public CA ID, or null for existing CA reuse."
  value       = module.cloudflare.database_ca_certificate_id
}

output "clerk_dns_records" {
  description = "Clerk production-domain CNAMEs owned by Terraform; empty when Clerk DNS is managed elsewhere."
  value       = try(module.clerk_dns[0].records, {})
}

output "uninstall" {
  description = "Destroy-time uninstall of the installer-created resources; null without a deployment."
  value       = module.installation.uninstall
}

output "reserved_routes" {
  description = "Hostname routes, without a Worker, that keep other Workers routes off the Board's hosts."
  value       = try(module.host_routes[0].patterns, [])
}
