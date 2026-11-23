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
    # Console release updates: the installer copies the image into this
    # account's container registry and deploys the installation's updater
    # Worker, which runs each update in a Cloudflare Container. Terraform
    # creates nothing for it.
    updater = var.updater_image == null ? null : { image = var.updater_image }
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

# Terraform never deploys the app: `cloudflare.ts deploy` runs the app's
# installer with this module's handoff, outside any plan, so changing a
# setting can never put an older release over a newer one.

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
# The uninstall runs payload/installer/cloudflare-install.js, from the
# payload directory, of the release the drivers export as AZAD_RELEASE (their
# --release), and otherwise of the one recorded at the last apply.
resource "terraform_data" "uninstall" {
  count = var.deployment.enabled ? 1 : 0

  input = {
    release_dir = var.release_dir
    target      = jsonencode(local.uninstall_input)
  }

  provisioner "local-exec" {
    when    = destroy
    command = "cd \"$${AZAD_RELEASE:-$AZAD_RECORDED_RELEASE}/payload\" && bun --no-env-file installer/cloudflare-install.js uninstall"
    environment = {
      AZAD_RECORDED_RELEASE    = try(coalesce(self.input.release_dir), "")
      AZAD_TERRAFORM_UNINSTALL = self.input.target
    }
  }
}
