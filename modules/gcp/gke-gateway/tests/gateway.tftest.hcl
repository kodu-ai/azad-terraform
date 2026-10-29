mock_provider "kubernetes" {}

variables {
  namespace      = "azad"
  static_ip_name = "azad-ingress"
  routes = [
    { host = "board.example.com", service = "azad-web", port = 80 },
    { host = "api.board.example.com", service = "azad-api", port = 80 },
    { host = "*.apps.board.example.com", service = "azad-api", port = 80 },
  ]
}

run "google_certificates_terminate_tls_in_the_region" {
  command = plan
  variables {
    certificates = ["azad-tls"]
  }
  assert {
    condition     = kubernetes_manifest.gateway.manifest.spec.gatewayClassName == "gke-l7-regional-external-managed" && kubernetes_manifest.gateway.manifest.spec.addresses[0].value == "azad-ingress"
    error_message = "The Gateway is a regional external Application Load Balancer on the reserved regional address."
  }
  assert {
    condition     = kubernetes_manifest.gateway.manifest.spec.listeners[1].tls.options["networking.gke.io/cert-manager-certs"] == "azad-tls"
    error_message = "Regional Certificate Manager certificates attach to the HTTPS listener by name; certificate maps are global only."
  }
  assert {
    condition     = kubernetes_manifest.route["azad-api"].manifest.spec.parentRefs[0].name == "azad-regional" && kubernetes_manifest.route["azad-api"].manifest.spec.parentRefs[0].sectionName == "https" && contains(kubernetes_manifest.route["azad-api"].manifest.spec.hostnames, "*.apps.board.example.com")
    error_message = "The API and the Mini App wildcard hosts are served over HTTPS by the regional Gateway."
  }
  assert {
    condition     = kubernetes_manifest.backend["azad-api"].manifest.spec.default.timeoutSec == 3600
    error_message = "Realtime WebSockets stay open for the hour-long backend timeout."
  }
}

run "a_proxying_cdn_gets_its_origin_certificate" {
  command = plan
  variables {
    tls = { certificate = "certificate", private_key = "key" }
  }
  assert {
    condition     = kubernetes_manifest.gateway.manifest.spec.listeners[1].tls.certificateRefs[0].name == "azad-origin-tls" && !contains(keys(kubernetes_manifest.gateway.manifest.spec.listeners[1].tls), "options")
    error_message = "Proxy mode presents the origin certificate from its Secret."
  }
}

run "without_certificates_only_plain_http_is_served" {
  command = plan
  assert {
    condition     = length(kubernetes_manifest.gateway.manifest.spec.listeners) == 1 && length(kubernetes_manifest.redirect) == 0 && kubernetes_manifest.route["azad-web"].manifest.spec.parentRefs[0].sectionName == "http"
    error_message = "Evaluation without DNS serves plain HTTP and does not redirect."
  }
}
