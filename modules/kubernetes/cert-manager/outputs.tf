output "namespace" {
  description = "cert-manager's namespace, ready once this module is applied."
  value       = helm_release.cert_manager.namespace
}
