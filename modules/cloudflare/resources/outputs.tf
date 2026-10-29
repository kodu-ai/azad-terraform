output "resource_prefix" {
  description = "Shared Terraform/installer resource prefix."
  value       = local.resource_prefix
}

output "resources" {
  description = "Terraform-owned resources; the installer only looks up these existing names. buckets is empty when the operator brings their own bucket."
  value = {
    buckets    = { for key, bucket in cloudflare_r2_bucket.storage : key => bucket.name }
    queue_name = cloudflare_queue.offline_delivery.queue_name
    queue_id   = cloudflare_queue.offline_delivery.id
  }
}

output "database_ca_certificate_id" {
  description = "Owned public CA registration, or null when the installer uses an external CA ID."
  value       = try(cloudflare_mtls_certificate.database_ca[0].id, null)
}
