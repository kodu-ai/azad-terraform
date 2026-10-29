# Clerk's production domain needs these CNAMEs (Frontend API, account portal,
# mail and DKIM). Setup reads Clerk's cname_targets with the instance secret key
# and passes only records that do not already exist. DNS-only: Clerk issues the
# certificates, so the records must not be proxied.
resource "cloudflare_dns_record" "clerk" {
  for_each = var.records

  zone_id = var.zone_id
  name    = each.key
  type    = "CNAME"
  content = each.value
  proxied = false
  ttl     = 1
  comment = "Clerk production domain for Azad"
}
