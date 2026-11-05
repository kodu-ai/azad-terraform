output "handoff" {
  description = "AZAD_CELLD_INSTALL for scripts/self-host/celld-install.ts without its revision, which the drivers add. Holds the database and managed Git passwords."
  sensitive   = true
  value       = local.handoff
}

output "log" {
  description = "Deploy progress log the drivers' deploy appends to."
  value       = "${local.state_directory}/install.log"
}

output "ssh_allowed_private_cidrs" {
  description = "Private networks the API may SSH into (SSH_ALLOWED_PRIVATE_CIDRS)."
  value       = local.handoff.ssh_allowed_private_cidrs
}
