output "uninstall" {
  description = "What destroy removes beyond Terraform's own resources: null without a deployment, otherwise the R2 buckets it empties (only this installation's) before Terraform deletes them."
  value       = var.deployment.enabled ? { buckets = local.uninstall_input.buckets } : null
}
