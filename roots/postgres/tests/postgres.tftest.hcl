mock_provider "cloudflare" {
  mock_resource "cloudflare_mtls_certificate" {
    defaults = { id = "2458ce5a-0c35-4c7f-82c7-8e9487d3ff60" }
  }
}
variables {
  # The Azad app source checkout; plans never run its entrypoints.
  source_dir   = "/opt/azad"
  database_url = "postgresql://azad:a%40b%20c%2B%2F@ep-test.eu-central-1.aws.neon.tech:5432/azad?sslmode=verify-full"
  cloudflare = {
    account_id = "00000000000000000000000000000000"
    api_origin = "https://api.board.example.com"
    web_origin = "https://board.example.com"
  }
  deployment = {
    enabled  = false
    revision = "0000000000000000000000000000000000000000"
  }
}
run "direct_tls_connection_and_current_storage" {
  command = plan
  assert {
    condition     = output.database_url == "postgresql://azad:a%40b%20c%2B%2F@ep-test.eu-central-1.aws.neon.tech:5432/azad?sslmode=verify-full"
    error_message = "Use the direct endpoint with verified TLS and encoded credentials."
  }
  assert {
    condition     = length(output.cloudflare_resources.buckets) == 2 && contains(keys(output.cloudflare_resources.buckets), "files") && contains(keys(output.cloudflare_resources.buckets), "agent_releases")
    error_message = "The current installer needs only files and release buckets."
  }
}
run "same_installer_handoff" {
  command = plan
  variables {
    deployment = {
      env_file = "tests/fixtures/settings.env"
      revision = "0000000000000000000000000000000000000000"
    }
  }
}

run "managed_neon_ca" {
  command = apply
  variables {
    database_ca     = "neon-isrg-root-x1"
    database_ca_pem = "-----BEGIN CERTIFICATE-----\nfake-public-ca-for-mocked-provider\n-----END CERTIFICATE-----"
  }
  assert {
    condition     = output.database_ca_certificate_id == "2458ce5a-0c35-4c7f-82c7-8e9487d3ff60"
    error_message = "The owned CA ID must reach the installer composition."
  }
}
run "refuse_managed_ca_for_other_provider" {
  command = plan
  variables {
    database_ca  = "neon-isrg-root-x1"
    database_url = "postgresql://azad:fake@db.example.com/azad?sslmode=verify-full"
  }
  expect_failures = [var.database_ca]
}
run "refuse_pooler_for_managed_ca" {
  command = plan
  variables {
    database_ca  = "neon-isrg-root-x1"
    database_url = "postgresql://azad:fake@ep-test-pooler.us-east-2.aws.neon.tech/azad?sslmode=verify-full"
  }
  expect_failures = [var.database_ca]
}

run "clerk_production_dns" {
  command = plan
  variables {
    clerk_dns = {
      zone_id = "11111111111111111111111111111111"
      records = {
        "clerk.board.example.com"          = "frontend-api.clerk.services"
        "clk._domainkey.board.example.com" = "dkim1.fixture.clerk.services"
      }
    }
  }
  assert {
    condition     = length(module.base.clerk_dns_records) == 2 && module.base.clerk_dns_records["clerk.board.example.com"].proxied == false
    error_message = "Clerk's CNAMEs must be created DNS-only in the selected zone."
  }
}

run "no_clerk_dns_without_targets" {
  command = plan
  assert {
    condition     = length(module.base.clerk_dns_records) == 0
    error_message = "Clerk DNS stays unmanaged when setup found no records to create."
  }
}

run "own_bucket_replaces_r2" {
  command = plan
  variables {
    storage = {
      adapter = "gcs"
      bucket  = "customer-azad-files"
    }
    deployment = {
      env_file = "tests/fixtures/settings.env"
      revision = "0000000000000000000000000000000000000000"
    }
  }
  assert {
    condition     = length(output.cloudflare_resources.buckets) == 0 && output.storage.bucket == "customer-azad-files"
    error_message = "An operator-owned bucket must replace this installation's R2 buckets."
  }
  assert {
    condition     = length(module.base.uninstall.buckets) == 0
    error_message = "Uninstall must never empty a bucket this installation does not own."
  }
}

run "uninstall_empties_only_owned_r2_buckets" {
  command = plan
  variables {
    deployment = {
      env_file = "tests/fixtures/settings.env"
      revision = "0000000000000000000000000000000000000000"
    }
  }
  assert {
    condition = jsonencode(module.base.uninstall.buckets) == jsonencode([
      "azad-api-board-example-com-7ec551c7-agent-releases",
      "azad-api-board-example-com-7ec551c7-files",
    ])
    error_message = "Destroy must empty exactly this installation's two R2 buckets."
  }
}

run "no_uninstall_without_deployment" {
  command = plan
  assert {
    condition     = module.base.uninstall == null
    error_message = "Infrastructure-only compositions have nothing for an uninstall to remove."
  }
}

run "refuse_bucket_fields_with_r2" {
  command = plan
  variables {
    storage = { bucket = "customer-azad-files" }
  }
  expect_failures = [var.storage]
}

run "s3_needs_region" {
  command = plan
  variables {
    storage = {
      adapter  = "s3"
      bucket   = "customer-azad-files"
      endpoint = "https://s3.example.com"
    }
  }
  expect_failures = [var.storage]
}

run "github_app_pending_is_reported" {
  command = plan
  variables {
    github_app_pending = true
  }
  assert {
    condition     = startswith(output.github_app, "PENDING")
    error_message = "A deferred GitHub App must be reported in the outputs."
  }
}

run "board_hosts_are_reserved_from_zone_wide_routes" {
  command = plan
  variables {
    host_zones = {
      "board.example.com"     = "11111111111111111111111111111111"
      "api.board.example.com" = "11111111111111111111111111111111"
    }
  }
  assert {
    condition     = toset(module.base.reserved_routes) == toset(["board.example.com/*", "api.board.example.com/*"])
    error_message = "Both Board hosts need a hostname route that runs no Worker."
  }
}
