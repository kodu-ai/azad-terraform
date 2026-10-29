terraform {
  # State lives where `init -backend-config=path=...` puts it: the drivers
  # (scripts/cloudflare.ts, scripts/gcp.ts) keep it in the instance directory.
  backend "local" {}
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.28.0" }
  }
}
