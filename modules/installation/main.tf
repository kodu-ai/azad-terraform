locals {
  # What the installer deploys; where its settings file, state directory and
  # the app source checkout live (all of which may move) is not part of it.
  installer_configuration = {
    revision                   = var.deployment.revision
    resource_prefix            = var.resource_prefix
    database_url               = var.database_url
    database_ca_certificate_id = var.database_ca_certificate_id
    account_id                 = var.cloudflare.account_id
    api_origin                 = var.cloudflare.api_origin
    web_origin                 = var.cloudflare.web_origin
    storage                    = var.storage
    github_app_pending         = var.github_app_pending
  }
  installer_input = merge(local.installer_configuration, {
    env_file        = abspath(var.deployment.env_file)
    state_directory = abspath(var.deployment.state_directory)
  })
  # Identity only: tokens are read from the installer file at destroy time.
  uninstall_input = {
    env_file        = abspath(var.deployment.env_file)
    resource_prefix = var.resource_prefix
    account_id      = var.cloudflare.account_id
    api_origin      = var.cloudflare.api_origin
    web_origin      = var.cloudflare.web_origin
    state_directory = abspath(var.deployment.state_directory)
    buckets         = sort(values(var.resources.buckets))
  }
}

# The app's own installer deploys it (scripts/self-host/cloudflare-install.ts
# in the Azad source checkout at var.source_dir); there is no second Worker
# configuration here. The checkout's HEAD must be deployment.revision. A failed
# creation is retried on the next apply using the same installer state.
resource "terraform_data" "install" {
  count = var.deployment.enabled ? 1 : 0

  triggers_replace = {
    revision      = var.deployment.revision
    configuration = sha256(jsonencode(local.installer_configuration))
    # The installer reads every setting but the guided installer's own
    # AZAD_CLI_* answers, so only those lines decide whether a settings change
    # redeploys. Only the digest is stored.
    settings = sha256(join("\n", [
      for line in split("\n", file(abspath(var.deployment.env_file))) : line
      if !startswith(line, "AZAD_CLI_")
    ]))
    resources = sha256(jsonencode(var.resources))
  }

  lifecycle {
    precondition {
      condition     = var.source_dir != null
      error_message = "Deploying needs the Azad app source checkout: run the driver with --source (or AZAD_SOURCE), or set source_dir."
    }
  }

  provisioner "local-exec" {
    working_dir = var.source_dir
    command     = "bun --no-env-file scripts/self-host/cloudflare-install.ts install"
    environment = {
      AZAD_TERRAFORM_INSTALL = jsonencode(local.installer_input)
    }
  }
}

# Makes `terraform destroy` a complete uninstall. Destroyed before the R2
# buckets, queue, CA and Clerk DNS it depends on, its provisioner removes what
# the installer created at runtime: this installation's Mini App Workers and
# D1 databases, API Worker and custom domains, Pages project and CNAME, and
# Hyperdrive; it empties the buckets above so Terraform can delete them. The
# operator's own database, object storage and Clerk application are kept.
#
# Separate from `install` and never replaced (input changes update in place),
# so a redeploy cannot trigger it. Disabling the deployment destroys it, which
# uninstalls the running instance.
#
# The uninstall runs scripts/self-host/cloudflare-install.ts from the source
# checkout the drivers export as AZAD_SOURCE (their --source), and otherwise
# from the one recorded at the last apply.
resource "terraform_data" "uninstall" {
  count = var.deployment.enabled ? 1 : 0

  input = {
    source_dir = var.source_dir
    target     = jsonencode(local.uninstall_input)
  }

  provisioner "local-exec" {
    when    = destroy
    command = "bun --no-env-file \"$${AZAD_SOURCE:-$AZAD_RECORDED_SOURCE}/scripts/self-host/cloudflare-install.ts\" uninstall"
    environment = {
      AZAD_RECORDED_SOURCE     = try(coalesce(self.input.source_dir), "")
      AZAD_TERRAFORM_UNINSTALL = self.input.target
    }
  }
}
