# Google-managed TLS for the regional HTTPS load balancer, independent of any
# CDN. Regional certificates attach to the load balancer directly (certificate
# maps are global only). DNS authorization proves domain control through one
# per-project CNAME per domain, so the certificate issues before the hostnames
# point at the load balancer, and it allows wildcard names at any depth
# (Cloudflare's free edge certificate covers only one subdomain level).

resource "google_project_service" "certificate_manager" {
  project            = var.project_id
  service            = "certificatemanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_certificate_manager_dns_authorization" "regional" {
  for_each = toset(var.domains)
  project  = var.project_id
  location = var.region
  name     = "${var.name}-${replace(each.value, ".", "-")}"
  domain   = each.value
  # The only type a regional authorization has.
  type = "PER_PROJECT_RECORD"

  depends_on = [google_project_service.certificate_manager]
}

resource "google_certificate_manager_certificate" "regional" {
  project  = var.project_id
  location = var.region
  name     = "${var.name}-tls"
  managed {
    domains            = flatten([for domain in var.domains : [domain, "*.${domain}"]])
    dns_authorizations = [for authorization in google_certificate_manager_dns_authorization.regional : authorization.id]
  }
}
