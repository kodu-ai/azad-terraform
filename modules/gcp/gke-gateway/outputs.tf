output "service_annotations" {
  description = "Annotations of each routed Service: the standalone NEG the GKE Gateway controller writes for the routed port, declared so plans stay clean."
  value = {
    for service in local.services : service => {
      "cloud.google.com/neg" = jsonencode({ exposed_ports = { tostring(local.ports[service][0]) = {} } })
    }
  }
}

output "name" {
  description = "Name of the Gateway, known once its routes and backend policies are applied."
  value       = kubernetes_manifest.gateway.manifest.metadata.name
  depends_on  = [kubernetes_manifest.route, kubernetes_manifest.redirect, kubernetes_manifest.health_check, kubernetes_manifest.backend]
}
