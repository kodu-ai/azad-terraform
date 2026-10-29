terraform {
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.0"
    }
  }
}

# The orchestrator supplies only the management token in process environment.
provider "cloudflare" {}

variable "tokens" {
  description = "Exact policies resolved from the official permission catalog by bootstrap.ts."
  type = map(object({
    name = string
    policies = list(object({
      effect            = string
      permission_groups = list(object({ id = string }))
      resources         = string
    }))
  }))
}

resource "cloudflare_api_token" "scoped" {
  for_each = var.tokens
  name     = each.value.name
  policies = each.value.policies
}

output "tokens" {
  sensitive = true
  value = { for key, token in cloudflare_api_token.scoped : key => {
    id    = token.id
    value = token.value
  } }
}
