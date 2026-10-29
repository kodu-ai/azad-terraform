mock_provider "cloudflare" {}

run "scoped_user_tokens" {
  command = plan
  variables {
    tokens = {
      deployment = {
        name = "azad-test-deployment"
        policies = [{
          effect            = "allow"
          permission_groups = [{ id = "00000000000000000000000000000001" }]
          resources         = "{\"com.cloudflare.api.account.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\":\"*\"}"
        }]
      }
      miniapps = {
        name = "azad-test-miniapps"
        policies = [{
          effect            = "allow"
          permission_groups = [{ id = "00000000000000000000000000000002" }]
          resources         = "{\"com.cloudflare.api.account.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\":\"*\"}"
        }]
      }
    }
  }
  assert {
    condition     = length(cloudflare_api_token.scoped) == 2 && !contains(keys(cloudflare_api_token.scoped), "discovery")
    error_message = "The final phase must retain only requested scoped tokens."
  }
  assert {
    condition     = jsondecode(cloudflare_api_token.scoped["deployment"].policies[0].resources)["com.cloudflare.api.account.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] == "*" && length(keys(jsondecode(cloudflare_api_token.scoped["deployment"].policies[0].resources))) == 1
    error_message = "The provider must receive the exact selected account policy."
  }
}

run "temporary_discovery" {
  command = plan
  variables {
    tokens = {
      discovery = {
        name = "azad-test-discovery"
        policies = [{
          effect            = "allow"
          permission_groups = [{ id = "c8fed203ed3043cba015a93ad1616f1f" }]
          resources         = "{\"com.cloudflare.api.account.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\":{\"com.cloudflare.api.account.zone.*\":\"*\"}}"
        }]
      }
    }
  }
  assert {
    condition     = length(cloudflare_api_token.scoped) == 1 && cloudflare_api_token.scoped["discovery"].policies[0].permission_groups[0].id == "c8fed203ed3043cba015a93ad1616f1f"
    error_message = "Discovery grants only the Zone Read permission."
  }
}
