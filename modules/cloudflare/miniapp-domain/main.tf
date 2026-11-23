# The Mini Apps domain of the loader provider (AZAD_SELF_HOST_MINIAPPS=loader).
# Each Mini App serves on https://<label>.<domain>; the app's deploy routes
# *.<domain>/* to the API Worker. This module makes those hosts reach
# Cloudflare's edge and gives them a certificate:
#
# - a proxied wildcard record *.<domain> (AAAA 100::, which only ever answers
#   through the proxy) in the zone that holds the domain;
# - for a domain below its zone's apex, an advanced certificate pack for
#   <domain> and *.<domain>. Universal SSL covers only the apex and its
#   first-level subdomains, so a zone apex needs none. Ordering one needs
#   Advanced Certificate Manager on the zone.

module "zone" {
  source = "../zone-lookup"

  domain     = var.domain
  account_id = var.account_id
}

locals {
  zone = module.zone.zone
  apex = local.zone == null ? false : local.zone.name == var.domain
}

resource "cloudflare_dns_record" "wildcard" {
  zone_id = local.zone == null ? "" : local.zone.id
  name    = "*.${var.domain}"
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Azad Mini Apps of ${var.installation} (managed by Terraform)"

  lifecycle {
    precondition {
      condition     = local.zone != null
      error_message = "The Mini Apps domain ${var.domain} (AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN) is not in a zone of this Cloudflare account that CLOUDFLARE_API_TOKEN can read. Add the zone to the account and give the token Zone Read, DNS Edit and Workers Routes Edit on it, or change the domain in the .env."
    }
  }
}

resource "cloudflare_certificate_pack" "miniapps" {
  count = local.zone != null && !local.apex ? 1 : 0

  zone_id = local.zone.id
  type    = "advanced"
  # Cloudflare requires the zone apex in every pack.
  hosts                 = [local.zone.name, var.domain, "*.${var.domain}"]
  validation_method     = "txt"
  validity_days         = 90
  certificate_authority = "google"
  cloudflare_branding   = false
}
