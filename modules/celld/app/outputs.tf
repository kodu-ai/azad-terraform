output "revision" {
  description = "Revision the fleets were deployed from."
  value       = terraform_data.deploy.triggers_replace.revision
}

output "log" {
  description = "Deploy progress log (Terraform hides the provisioner's output)."
  value       = "${local.state_directory}/install.log"
}

output "ssh_allowed_private_cidrs" {
  description = "Private networks the API may SSH into (SSH_ALLOWED_PRIVATE_CIDRS)."
  value       = local.handoff.ssh_allowed_private_cidrs
}
