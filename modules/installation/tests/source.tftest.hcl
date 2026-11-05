# The deploy runs outside Terraform with this module's handoff; the uninstall
# runs the app's own entrypoint from its source checkout. Plan-only: no
# provisioner runs.
variables {
  cloudflare = {
    account_id = "00000000000000000000000000000000"
    api_origin = "https://api.board.example.com"
    web_origin = "https://board.example.com"
  }
  deployment = {
    env_file = "tests/fixtures/settings.env"
  }
  resource_prefix = "azad-api-board-example-com-7ec551c7"
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

run "the_deploy_handoff_names_the_installation_without_credentials" {
  command = plan
  assert {
    condition     = output.installer_input.resource_prefix == "azad-api-board-example-com-7ec551c7" && startswith(output.installer_input.env_file, "/")
    error_message = "The deploy gets the installation's identity and absolute instance paths."
  }
  assert {
    condition     = !contains(keys(output.installer_input), "database_url") && !contains(keys(output.installer_input), "revision")
    error_message = "The driver adds the database URL and the revision; Terraform stores neither."
  }
}

run "infrastructure_only_needs_no_source" {
  command = plan
  variables {
    deployment = {
      enabled = false
    }
  }
  assert {
    condition     = output.installer_input == null && length(terraform_data.uninstall) == 0
    error_message = "Without a deployment nothing is deployed or uninstalled."
  }
}
