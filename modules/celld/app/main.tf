# Deploys the Azad app onto celld fleets: instance keys, schema migrations,
# the Agent Connect release mirror, bundle builds and `celld deploy` are not
# expressible as Terraform resources, so a local-exec provisioner runs
# scripts/self-host/celld-install.ts from the Azad source checkout at
# var.source_dir. It reruns whenever the revision, this configuration or the
# private settings file change; a failed run is retried on the next apply with
# the same state.

locals {
  state_directory = abspath(var.deployment.state_directory)
  # What the deploy deploys; where its settings file, state directory and the
  # app source checkout live (all of which may move) is not part of it.
  configuration = {
    revision              = var.deployment.revision
    fleets                = var.fleets
    origins               = var.origins
    miniapp_base_domain   = var.miniapp_base_domain
    ready_timeout_seconds = var.ready_timeout_minutes * 60
    # Not secret: part of the handoff, so a change redeploys (configuration).
    ssh_allowed_private_cidrs = var.ssh_allowed_private_cidrs
  }
  handoff = merge(local.configuration, {
    env_file        = abspath(var.deployment.env_file)
    state_directory = local.state_directory
  })
}

resource "terraform_data" "deploy" {
  triggers_replace = {
    revision      = var.deployment.revision
    configuration = sha256(jsonencode(local.configuration))
    # Only digests: the passwords stay out of the plan.
    database    = nonsensitive(sha256(jsonencode(var.database)))
    managed_git = nonsensitive(sha256(jsonencode(var.managed_git)))
    # The deploy reads every setting but the guided installer's own
    # AZAD_CLI_* answers, so only those lines decide whether a settings change
    # redeploys.
    settings = sha256(join("\n", [
      for line in split("\n", file(local.handoff.env_file)) : line
      if !startswith(line, "AZAD_CLI_")
    ]))
  }

  lifecycle {
    precondition {
      condition     = var.source_dir != null
      error_message = "Deploying needs the Azad app source checkout: run the driver with --source (or AZAD_SOURCE), or set source_dir."
    }
  }

  # Terraform hides the output of a provisioner with sensitive inputs, so the
  # script's progress is also appended to <state_directory>/install.log.
  provisioner "local-exec" {
    working_dir = var.source_dir
    interpreter = ["/bin/bash", "-o", "pipefail", "-c"]
    command     = "umask 077 && mkdir -p \"$AZAD_CELLD_STATE\" && bun --no-env-file scripts/self-host/celld-install.ts 2>&1 | tee -a \"$AZAD_CELLD_STATE/install.log\""
    environment = {
      AZAD_CELLD_STATE   = local.state_directory
      AZAD_CELLD_INSTALL = jsonencode(merge(local.handoff, { database = var.database, managed_git = var.managed_git }))
    }
  }
}
