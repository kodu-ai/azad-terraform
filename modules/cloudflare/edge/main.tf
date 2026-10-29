# Cloudflare in front of a self-hosted origin: proxied DNS, Cloudflare's edge
# certificate for browsers, and an Origin CA certificate that the origin load
# balancer presents so the Cloudflare-to-origin hop is verified TLS.

resource "tls_private_key" "origin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  dns_names       = var.hosts
  subject {
    common_name = var.hosts[0]
  }
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = var.hosts
  request_type       = "origin-ecc"
  requested_validity = 5475
}

resource "cloudflare_dns_record" "origin" {
  for_each = toset(var.hosts)
  zone_id  = var.zone_id
  name     = each.value
  type     = "A"
  content  = var.origin_address
  proxied  = true
  ttl      = 1
  comment  = "Azad origin (managed by Terraform)"
}

locals {
  exact     = [for host in var.hosts : host if !startswith(host, "*.")]
  wildcards = [for host in var.hosts : trimprefix(host, "*") if startswith(host, "*.")]
  host_expression = join(" or ", concat(
    length(local.exact) > 0 ? ["(http.host in {${join(" ", [for host in local.exact : jsonencode(host)])}})"] : [],
    [for suffix in local.wildcards : "ends_with(http.host, ${jsonencode(suffix)})"],
  ))
}

# Origin CA certificates are trusted only by Cloudflare, so the hop must be
# Full (strict): Flexible would send plaintext to an HTTPS-only origin.
resource "cloudflare_ruleset" "ssl" {
  count       = var.manage_ssl_rule ? 1 : 0
  zone_id     = var.zone_id
  name        = "Azad origin TLS"
  description = "Full (strict) TLS to the Azad origin"
  kind        = "zone"
  phase       = "http_config_settings"
  rules = [{
    action            = "set_config"
    action_parameters = { ssl = "strict" }
    expression        = local.host_expression
    description       = "Azad hosts use Full (strict) TLS"
    enabled           = true
  }]
}
