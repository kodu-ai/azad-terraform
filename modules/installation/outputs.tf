output "uninstall" {
  description = "What destroy removes beyond Terraform's own resources: null without a deployment, otherwise the R2 buckets it empties (only this installation's) before Terraform deletes them."
  value       = var.deployment.enabled ? { buckets = local.uninstall_input.buckets } : null
}

output "installer_input" {
  description = "The handoff `cloudflare.ts deploy` gives the app's cloudflare-install.ts, without its revision and database URL; null without a deployment."
  value       = var.deployment.enabled ? local.installer_input : null
}
