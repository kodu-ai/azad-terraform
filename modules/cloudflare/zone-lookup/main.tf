# The zone of the account that holds a domain: the longest zone name that is
# the domain or one of its parents. Zones the token cannot read are not
# found.

locals {
  labels = split(".", var.domain)
  # The domain, then each parent with at least two labels, longest first.
  candidates = [for index in range(length(local.labels) - 1) : join(".", slice(local.labels, index, length(local.labels)))]
}

data "cloudflare_zones" "candidate" {
  for_each = toset(local.candidates)

  name    = each.value
  account = { id = var.account_id }
}

locals {
  matches = flatten([for name in local.candidates : [
    for zone in data.cloudflare_zones.candidate[name].result : { id = zone.id, name = zone.name } if zone.name == name
  ]])
}
