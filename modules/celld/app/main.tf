# What `gcp.ts deploy` hands the app's scripts/self-host/celld-install.ts: the
# fleets, origins, database and managed Git this configuration created.
# Terraform no longer deploys the app itself. Instance keys, schema
# migrations, the Agent Connect release mirror, bundle builds and `celld
# deploy` run in the driver's deploy step, outside any plan, so changing a
# setting can never put the source's revision over a newer release.

locals {
  state_directory = abspath(var.deployment.state_directory)
  handoff = {
    env_file              = abspath(var.deployment.env_file)
    state_directory       = local.state_directory
    fleets                = var.fleets
    origins               = var.origins
    miniapp_base_domain   = var.miniapp_base_domain
    ready_timeout_seconds = var.ready_timeout_minutes * 60
    database              = var.database
    managed_git           = var.managed_git
    # Not secret: part of the handoff.
    ssh_allowed_private_cidrs = var.ssh_allowed_private_cidrs
    updater                   = var.updater
  }
}

# Releases before 0.1.0 deployed from here with a local-exec provisioner. The
# installed app stays as it is; only Terraform's record of it goes.
removed {
  from = terraform_data.deploy
  lifecycle {
    destroy = false
  }
}
