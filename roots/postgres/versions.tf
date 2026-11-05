terraform {
  # State lives in the installation's own R2 bucket, through R2's S3 API
  # with a lock object written create-only (use_lockfile). The drivers
  # (scripts/cloudflare.ts) create the bucket and point `init` at it; see
  # scripts/state.ts.
  backend "s3" {}
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.28.0" }
  }
}
