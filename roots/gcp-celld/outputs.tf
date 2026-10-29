output "fleets" {
  description = "Fleet buckets the deploy writes bundles and R2-binding objects into (gs:// with ADC)."
  value = {
    api = module.api.bucket
    web = module.web.bucket
  }
}

output "origins" {
  description = "Public origins."
  value = {
    web  = "https://${var.web_host}"
    api  = "https://${local.api_host}"
    apps = "https://${local.apps_host}"
  }
}

output "cluster" {
  description = "Cluster name and location for gcloud get-credentials."
  value = {
    name     = module.gke.cluster.name
    location = module.gke.cluster.location
  }
}

output "database" {
  description = "Cloud SQL instance; the Worker reaches it through its pod's PgBouncer (127.0.0.1:6432) and Cloud SQL Auth Proxy sidecar (127.0.0.1:5432)."
  value = {
    connection_name = module.database.connection.connection_name
    database        = module.database.connection.database
    username        = module.database.connection.username
  }
}

output "deployment" {
  description = "Deployed revision and the deploy log; null when only infrastructure is managed."
  value = var.deployment == null ? null : {
    revision = module.app[0].revision
    log      = module.app[0].log
  }
}

output "load_balancer_address" {
  description = "Regional static IP of the HTTPS load balancer."
  value       = module.gke.ingress_address.address
}

output "agent_machine" {
  description = "The agent machine, if one was chosen: connect it in project setup as \"A server over SSH\" with this host, port and user, and the key from agent_machine_private_key."
  value       = var.agent_machine == null ? null : merge(module.agent_machine[0].address, { size = var.agent_machine.label })
}

output "agent_machine_private_key" {
  description = "Private key for the agent machine's user: terraform output -raw agent_machine_private_key."
  sensitive   = true
  value       = var.agent_machine == null ? null : module.agent_machine[0].private_key
}
