output "service_account" {
  description = "Kubernetes service account update Jobs run as; give it the fleet bucket too (module.gke fleet_service_accounts)."
  value       = kubernetes_service_account_v1.updater.metadata[0].name
}

output "starter" {
  description = "The starter sidecar for the API fleet's sidecars (modules/celld/fleet). It alone gets the pod's Kubernetes token."
  value = {
    name  = "updater-starter"
    image = var.image
    args  = ["update-host", "gke"]
    env = {
      AZAD_UPDATER_LISTEN          = local.listen
      AZAD_UPDATER_IMAGE           = var.image
      AZAD_UPDATER_NAMESPACE       = var.namespace
      AZAD_UPDATER_SERVICE_ACCOUNT = kubernetes_service_account_v1.updater.metadata[0].name
      AZAD_INSTALL_STORE           = jsonencode({ kind = "gcs", bucket = var.install_bucket, project_id = var.project_id })
    }
    cpu_request          = "50m"
    memory_request       = "128Mi"
    run_as_user          = 65532
    kubernetes_api_token = true
  }
}

output "url" {
  description = "Where the API reaches the starter: the pod's loopback (AZAD_UPDATER_URL)."
  value       = "http://${local.listen}"
}
