# The deploy and uninstall run the app's own entrypoints from its source
# checkout. Plan-only: no provisioner runs.
variables {
  cloudflare = {
    account_id = "00000000000000000000000000000000"
    api_origin = "https://api.board.example.com"
    web_origin = "https://board.example.com"
  }
  deployment = {
    env_file = "tests/fixtures/settings.env"
    revision = "0000000000000000000000000000000000000000"
  }
  resource_prefix = "azad-api-board-example-com-7ec551c7"
  database_url    = "postgresql://azad:fixture@db.example.com:5432/azad?sslmode=require"
  resources = {
    buckets    = { files = "azad-api-board-example-com-7ec551c7-files" }
    queue_id   = "fixture-queue"
    queue_name = "azad-api-board-example-com-7ec551c7-offline-delivery"
  }
}

run "the_uninstall_records_the_source_it_was_applied_from" {
  command = plan
  variables {
    source_dir = "/opt/azad"
  }
  assert {
    condition     = terraform_data.uninstall[0].input.source_dir == "/opt/azad"
    error_message = "A destroy must find the checkout that deployed the app."
  }
  assert {
    condition     = !strcontains(terraform_data.uninstall[0].input.target, "fixture@")
    error_message = "The uninstall identity carries no database credential."
  }
}

run "a_deploy_needs_the_source_checkout" {
  command         = plan
  expect_failures = [terraform_data.install]
}

run "infrastructure_only_needs_no_source" {
  command = plan
  variables {
    deployment = {
      enabled  = false
      revision = "0000000000000000000000000000000000000000"
    }
  }
  assert {
    condition     = length(terraform_data.install) == 0 && length(terraform_data.uninstall) == 0
    error_message = "Without a deployment nothing runs from the source."
  }
}
