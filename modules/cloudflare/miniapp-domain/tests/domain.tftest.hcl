# Mocked provider, plan-only: the zone lookup answers what each run overrides.
# (Terraform cannot mock the list the zones data source returns, so the
# lookup is a module of its own.)
mock_provider "cloudflare" {}

variables {
  account_id   = "00000000000000000000000000000000"
  installation = "azad-api-board-example-com-7ec551c7"
}

run "a_zone_apex_gets_the_wildcard_record_and_no_certificate" {
  command = plan
  variables {
    domain = "example-apps.com"
  }
  override_module {
    target  = module.zone
    outputs = { zone = { id = "22222222222222222222222222222222", name = "example-apps.com" } }
  }
  assert {
    condition     = cloudflare_dns_record.wildcard.zone_id == "22222222222222222222222222222222" && cloudflare_dns_record.wildcard.name == "*.example-apps.com"
    error_message = "The wildcard record goes into the domain's own zone."
  }
  assert {
    condition     = cloudflare_dns_record.wildcard.type == "AAAA" && cloudflare_dns_record.wildcard.content == "100::" && cloudflare_dns_record.wildcard.proxied
    error_message = "The wildcard answers only through Cloudflare's proxy."
  }
  assert {
    condition     = strcontains(cloudflare_dns_record.wildcard.comment, "azad-api-board-example-com-7ec551c7")
    error_message = "The record names the installation it belongs to."
  }
  assert {
    condition     = length(cloudflare_certificate_pack.miniapps) == 0
    error_message = "Universal SSL covers a zone apex's first-level subdomains."
  }
}

run "a_subdomain_gets_an_advanced_certificate_in_its_zone" {
  command = plan
  variables {
    domain = "testing.azadd.dev"
  }
  override_module {
    target  = module.zone
    outputs = { zone = { id = "33333333333333333333333333333333", name = "azadd.dev" } }
  }
  assert {
    condition     = cloudflare_dns_record.wildcard.zone_id == "33333333333333333333333333333333" && cloudflare_dns_record.wildcard.name == "*.testing.azadd.dev"
    error_message = "The wildcard record goes into the zone that holds the domain."
  }
  assert {
    condition     = cloudflare_certificate_pack.miniapps[0].zone_id == "33333333333333333333333333333333" && toset(cloudflare_certificate_pack.miniapps[0].hosts) == toset(["azadd.dev", "testing.azadd.dev", "*.testing.azadd.dev"])
    error_message = "The pack covers the domain and its wildcard, with the zone apex Cloudflare requires."
  }
  assert {
    condition     = cloudflare_certificate_pack.miniapps[0].type == "advanced" && cloudflare_certificate_pack.miniapps[0].validation_method == "txt" && cloudflare_certificate_pack.miniapps[0].validity_days == 90 && cloudflare_certificate_pack.miniapps[0].certificate_authority == "google"
    error_message = "An advanced pack validated by TXT records."
  }
  assert {
    condition     = output.miniapps.zone == "azadd.dev" && output.miniapps.domain == "testing.azadd.dev"
    error_message = "The output names the domain and its zone."
  }
}

run "a_domain_outside_the_account_is_refused" {
  command = plan
  variables {
    domain = "apps.example.net"
  }
  override_module {
    target  = module.zone
    outputs = { zone = null }
  }
  expect_failures = [cloudflare_dns_record.wildcard]
}

run "a_domain_name_is_required" {
  command = plan
  variables {
    domain = "https://apps.example.com"
  }
  expect_failures = [var.domain]
}
