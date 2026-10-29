output "manifests" {
  description = "The applied objects, as passed in."
  value       = var.manifests
  depends_on  = [helm_release.this]
}
