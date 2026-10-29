output "url" {
  description = "Cluster-internal base URL of the REST API and Git smart HTTP (http://<name>-http.<namespace>.svc.cluster.local:3000)."
  value       = local.url
  depends_on  = [helm_release.forgejo]
}

output "username" {
  description = "Service account for HTTP Basic auth."
  value       = var.username
}

output "password" {
  description = "Service account password."
  value       = random_password.service.result
  sensitive   = true
}
