# Mock providers + plan-only runs: no cloud credentials, APIs or resources.
mock_provider "google" {}
mock_provider "cloudflare" {}
mock_provider "random" {
  override_during = plan
  mock_resource "random_password" {
    defaults = { result = "GeneratedPasswordForOfflineTest123" }
  }
}

override_resource {
  override_during = plan
  target          = module.base.module.database.google_sql_database_instance.postgres
  values = {
    public_ip_address = "192.0.2.1"
    connection_name   = "customer-project-id:me-central2:customer-azad-postgres"
  }
}

variables {
  # The Azad app source checkout; plans never run its entrypoints.
  source_dir = "/opt/azad"
  gcp = {
    project_id    = "customer-project-id"
    instance_name = "customer-azad-postgres"
    authorized_networks = {
      hyperdrive = "192.0.2.0/24"
      runner     = "198.51.100.10/32"
    }
  }
  database_password = "p@ss word+/"
  cloudflare = {
    account_id = "00000000000000000000000000000000"
    api_origin = "https://api.board.example.com"
    web_origin = "https://board.example.com"
  }
  deployment = {
    enabled         = false
    env_file        = "tests/fixtures/settings.env"
    revision        = "0000000000000000000000000000000000000000"
    state_directory = ".installer-state"
  }
}

run "infrastructure_contract" {
  command = plan

  assert {
    condition     = output.database_url == "postgresql://azad:p%40ss%20word%2B%2F@192.0.2.1:5432/azad?sslmode=require"
    error_message = "The DSN must preserve reserved password characters and require TLS."
  }
  assert {
    condition     = output.cloudflare_resources.buckets.files == "azad-api-board-example-com-7ec551c7-files" && output.cloudflare_resources.queue_name == "azad-api-board-example-com-7ec551c7-offline-delivery"
    error_message = "Resources must use the existing installer's names."
  }
  assert {
    condition     = output.storage.adapter == "r2" && length(output.cloudflare_resources.buckets) == 2
    error_message = "Without an operator-owned bucket the installation keeps its own R2 buckets."
  }
}

run "installer_handoff" {
  command = plan
  variables {
    deployment = {
      env_file        = "tests/fixtures/settings.env"
      revision        = "0000000000000000000000000000000000000000"
      state_directory = ".installer-state"
    }
  }
}

run "reject_invalid_network" {
  command = plan
  variables {
    gcp = {
      project_id          = "customer-project-id"
      instance_name       = "customer-azad-postgres"
      authorized_networks = { runner = "not-a-cidr" }
    }
  }
  expect_failures = [var.gcp]
}

run "reject_combined_instance_name_too_long" {
  command = plan
  variables {
    gcp = {
      project_id          = "customer-project-id"
      instance_name       = "customer-azad-postgres-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      authorized_networks = { runner = "198.51.100.10/32" }
    }
  }
  expect_failures = [var.gcp]
}

run "minimal_generated_configuration" {
  command = plan
  variables {
    database_password = null
    gcp = {
      project_id          = "customer-project-id"
      authorized_networks = { runner = "198.51.100.10/32" }
    }
    deployment = {
      enabled  = false
      revision = "0000000000000000000000000000000000000000"
    }
  }
  assert {
    condition     = output.database_url == "postgresql://azad:GeneratedPasswordForOfflineTest123@192.0.2.1:5432/azad?sslmode=require"
    error_message = "Omitting the password must use the persistent Terraform-generated secret."
  }
  assert {
    condition     = output.database.instance == "azad-7ec551c78fb7"
    error_message = "Omitting the SQL name must derive it from the API origin."
  }
}
