locals {
  # Matches resourceNames in the Azad app's scripts/self-host/install.ts. The
  # app's cloudflare-install.ts checks the names against that function before
  # allowing a deployment.
  host_slug       = replace(trimprefix(var.api_origin, "https://"), "/[^a-z0-9]+/", "-")
  resource_prefix = "${trimsuffix(substr("azad-${local.host_slug}", 0, 30), "-")}-${substr(sha256(var.api_origin), 0, 8)}"
  buckets = {
    files          = "${local.resource_prefix}-files"
    agent_releases = "${local.resource_prefix}-agent-releases"
  }
}

resource "cloudflare_r2_bucket" "storage" {
  for_each = var.r2_buckets ? local.buckets : {}

  account_id = var.account_id
  name       = each.value
}

resource "cloudflare_queue" "offline_delivery" {
  account_id = var.account_id
  queue_name = "${local.resource_prefix}-offline-delivery"
}

# Public CA from the runner's OS trust store: no private key. State owns this installation's registration;
# external CA IDs remain unmanaged. Rotation must publish a new CA and move
# Hyperdrive before the old certificate can be retired.
resource "cloudflare_mtls_certificate" "database_ca" {
  count        = var.register_neon_ca ? 1 : 0
  account_id   = var.account_id
  ca           = true
  certificates = var.database_ca_pem
  name         = "${local.resource_prefix}-isrg-root-x1"

  lifecycle {
    create_before_destroy = true

  }
}
