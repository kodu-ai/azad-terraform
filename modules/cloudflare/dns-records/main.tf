# DNS records only. With proxied = false Cloudflare is the authoritative DNS
# and the origin terminates TLS itself (for example a Google-managed certificate).
resource "cloudflare_dns_record" "this" {
  for_each = var.records
  zone_id  = var.zone_id
  name     = each.value.name
  type     = each.value.type
  content  = each.value.content
  proxied  = each.value.proxied
  ttl      = 1
  comment  = "Azad (managed by Terraform)"
}
