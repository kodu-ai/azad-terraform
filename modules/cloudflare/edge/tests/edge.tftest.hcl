mock_provider "cloudflare" {}
mock_provider "tls" {}

variables {
  zone_id        = "11111111111111111111111111111111"
  hosts          = ["board.example.com", "api.board.example.com", "*.apps.board.example.com"]
  api_host       = "api.board.example.com"
  origin_address = "203.0.113.20"
}

run "configuration_rules_for_the_hosts" {
  command = plan
  assert {
    condition     = cloudflare_ruleset.ssl[0].phase == "http_config_settings" && cloudflare_ruleset.ssl[0].rules[0].action_parameters.ssl == "strict" && cloudflare_ruleset.ssl[0].rules[0].expression == "(http.host in {\"board.example.com\" \"api.board.example.com\"}) or ends_with(http.host, \".apps.board.example.com\")"
    error_message = "Every host uses Full (strict) TLS to the origin."
  }
  assert {
    condition     = cloudflare_ruleset.ssl[0].rules[1].action_parameters.bic == false && cloudflare_ruleset.ssl[0].rules[1].expression == "http.host eq \"api.board.example.com\" and (starts_with(http.request.uri.path, \"/api/apps/files/uploads/\") or starts_with(http.request.uri.path, \"/api/apps/files/downloads/\") or starts_with(http.request.uri.path, \"/api/handoff/\") or starts_with(http.request.uri.path, \"/api/mcp-results/download/\"))"
    error_message = "Only the API's signed upload, download and handoff links skip Browser Integrity Check."
  }
}

run "a_zone_with_its_own_configuration_rules" {
  command = plan
  variables {
    manage_ssl_rule = false
  }
  assert {
    condition     = length(cloudflare_ruleset.ssl) == 0
    error_message = "The zone's existing Configuration Rules entrypoint is left alone."
  }
}

run "the_api_host_is_one_of_the_hosts" {
  command = plan
  variables {
    api_host = "api.other.example.com"
  }
  expect_failures = [var.api_host]
}
