locals {
  # What `cloudflare.ts deploy` hands the app's installer
  # (AZAD_TERRAFORM_INSTALL without its revision, which the driver adds).
  # The database URL is left out: the driver passes the operator's own from
  # the settings file (a DSN Terraform never stores), or Cloud SQL's output.
  installer_input = {
    resource_prefix            = var.resource_prefix
    database_ca_certificate_id = var.database_ca_certificate_id
    account_id                 = var.cloudflare.account_id
    api_origin                 = var.cloudflare.api_origin
    web_origin                 = var.cloudflare.web_origin
    storage                    = var.storage
    github_app_pending         = var.github_app_pending
    env_file                   = abspath(var.deployment.env_file)
    state_directory            = abspath(var.deployment.state_directory)
  }
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

# Terraform no longer deploys the app: `cloudflare.ts deploy` runs the app's
# scripts/self-host/cloudflare-install.ts with this module's handoff, outside
# any plan, so changing a setting can never put the source's revision over a
# newer release. Releases before 0.1.0 deployed from a provisioner here; the
# installed app stays as it is, only Terraform's record of it goes.
removed {
  from = terraform_data.install
  lifecycle {
    destroy = false
  }
}

# Makes `terraform destroy` a complete uninstall. Destroyed before the R2
# buckets, queue, CA and Clerk DNS it depends on, its provisioner removes what
# the installer created at runtime: this installation's Mini App Workers and
# D1 databases, API Worker and custom domains, Pages project and CNAME, and
# Hyperdrive; it empties the buckets above so Terraform can delete them. The
# operator's own database, object storage and Clerk application are kept.
#
# Never replaced (input changes update in place), so no deploy can trigger it.
# Disabling the deployment destroys it, which uninstalls the running instance.
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
