output "zone" {
  description = "The zone's id and name, or null when no zone of the account holds the domain."
  value       = length(local.matches) > 0 ? local.matches[0] : null
}
