# Reserves the Board's hostnames from other Workers routes in their zones. A
# zone-wide route such as "*.example.com/*" otherwise wins over the API
# Worker's Custom Domain and the Pages domain and serves another Worker on
# them. A hostname-specific route without a Worker is more specific than any
# wildcard and runs no Worker, so the Custom Domain and Pages answer. Existing
# routes are never changed.
resource "cloudflare_workers_route" "reserved" {
  for_each = var.hosts

  zone_id = each.value
  pattern = "${each.key}/*"
}
