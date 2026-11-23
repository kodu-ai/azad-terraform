output "miniapps" {
  description = "The Mini Apps domain, the zone that holds it, the wildcard record and, below the zone's apex, the advanced certificate pack."
  value = {
    domain           = var.domain
    zone             = local.zone == null ? null : local.zone.name
    zone_id          = local.zone == null ? null : local.zone.id
    wildcard         = cloudflare_dns_record.wildcard.name
    certificate_pack = length(cloudflare_certificate_pack.miniapps) == 0 ? null : cloudflare_certificate_pack.miniapps[0].id
  }
}
