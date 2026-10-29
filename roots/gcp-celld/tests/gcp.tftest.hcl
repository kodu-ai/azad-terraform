mock_provider "google" {
  override_during = plan
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  mock_data "google_client_config" {
    defaults = { access_token = "mock-token" }
  }
  mock_resource "google_compute_address" {
    defaults = { address = "203.0.113.20" }
  }
  mock_data "google_compute_zones" {
    defaults = { names = ["me-central1-a"] }
  }
}
mock_provider "kubernetes" {}

mock_provider "cloudflare" {}
mock_provider "helm" {}
mock_provider "http" {}

# The operator module fetches and digest-checks the published manifest; its own
# test covers that, so here it stands as its output.
override_module {
  target  = module.cloud_sql_proxy_operator
  outputs = { ready = "cloud-sql-proxy-operator-system" }
}
# The cluster's subnetwork and its range are known once the cluster exists;
# here they stand as the region's default subnet.
override_resource {
  target          = module.gke.google_container_cluster.celld
  override_during = plan
  values          = { subnetwork = "default" }
}
override_data {
  target          = data.google_compute_subnetwork.cluster
  override_during = plan
  values          = { ip_cidr_range = "10.212.0.0/20" }
}
mock_provider "tls" {}
mock_provider "random" {
  override_during = plan
  mock_resource "random_id" {
    defaults = { hex = "a1b2c3d4" }
  }
}

variables {
  # The Azad app source checkout; plans never run its entrypoints.
  source_dir         = "/opt/azad"
  project_id         = "customer-project"
  web_host           = "board.example.com"
  cloudflare_zone_id = "11111111111111111111111111111111"
}

run "dns_only_with_google_certificates" {
  command = plan
  assert {
    condition     = output.origins.api == "https://api.board.example.com" && output.origins.apps == "https://*.apps.board.example.com"
    error_message = "API and Mini App hosts derive from the web host."
  }
  assert {
    condition     = output.fleets.api == "gs://azad-fleet-a1b2c3d4/api" && output.fleets.web == "gs://azad-fleet-a1b2c3d4/web"
    error_message = "Each fleet gets its own prefix in the one GCS fleet bucket."
  }
  assert {
    condition     = length(module.certificates) == 1 && length(module.dns) == 1 && length(module.edge) == 0
    error_message = "By default Cloudflare is DNS only and Google issues the certificates."
  }
  assert {
    condition     = output.load_balancer_address == "203.0.113.20" && module.gateway.name == "azad-regional"
    error_message = "The regional Gateway serves on the installation's regional address."
  }
  assert {
    condition     = length(module.certificate_dns) == 1 && length(terraform_data.load_balancer_ready) == 1
    error_message = "Domain-control records stand apart from the hostnames, which wait until the load balancer serves them."
  }
  assert {
    condition     = module.gateway.service_annotations["azad-api"]["cloud.google.com/neg"] == "{\"exposed_ports\":{\"80\":{}}}"
    error_message = "Routed Services declare the standalone NEG the Gateway controller manages for their port."
  }
}

run "cloudflare_proxy_with_origin_certificate" {
  command = plan
  variables {
    cloudflare_proxy = true
  }
  assert {
    condition     = length(module.edge) == 1 && length(module.certificates) == 0 && length(module.dns) == 0
    error_message = "Proxy mode uses Cloudflare's edge and an Origin CA certificate instead."
  }
  assert {
    condition     = length(terraform_data.load_balancer_ready) == 1
    error_message = "Proxied hostnames also move only once the load balancer serves them."
  }
}

run "no_dns_serves_plain_http_for_evaluation" {
  command = plan
  variables {
    cloudflare_zone_id = null
  }
  assert {
    condition     = length(module.certificates) == 0 && length(module.dns) == 0 && length(module.edge) == 0 && length(terraform_data.load_balancer_ready) == 0
    error_message = "Without a zone nothing is created in Cloudflare and nothing waits for HTTPS."
  }
}

run "infrastructure_only_without_a_deployment" {
  command = plan
  assert {
    condition     = length(module.app) == 0 && output.deployment == null
    error_message = "Without a deployment only infrastructure is managed."
  }
}

run "deploys_the_app_after_the_infrastructure" {
  command = plan
  variables {
    deployment = {
      revision = "0123456789abcdef0123456789abcdef01234567"
      env_file = "tests/fixtures/settings.env"
    }
  }
  assert {
    condition     = output.deployment.revision == "0123456789abcdef0123456789abcdef01234567"
    error_message = "The deploy is keyed to the reviewed revision."
  }
  assert {
    condition     = endswith(output.deployment.log, "/roots/gcp-celld/.celld-install/install.log")
    error_message = "The deploy log lives in the persistent state directory beside the root."
  }
}

run "deploying_needs_https_origins" {
  command = plan
  variables {
    cloudflare_zone_id = null
    deployment = {
      revision = "0123456789abcdef0123456789abcdef01234567"
      env_file = "tests/fixtures/settings.env"
    }
  }
  expect_failures = [var.deployment]
}

run "database_proxy_comes_from_the_operator" {
  command = plan
  assert {
    condition     = module.database_proxy.manifests[0].kind == "AuthProxyWorkload" && module.database_proxy.manifests[0].spec.workloadSelector.kind == "StatefulSet" && module.database_proxy.manifests[0].spec.workloadSelector.name == "azad-api"
    error_message = "The operator injects the proxy into the azad-api StatefulSet."
  }
  assert {
    condition     = module.database_proxy.manifests[0].spec.instances[0].port == 5432 && module.database_proxy.manifests[0].metadata.namespace == "azad"
    error_message = "The proxy listens where the API pods' PgBouncer connects: 127.0.0.1:5432 in their namespace."
  }
  assert {
    condition     = module.api.database_endpoint == "127.0.0.1:6432"
    error_message = "The Worker's DATABASE_URL names the pod's PgBouncer, which pools connections through the proxy."
  }
  assert {
    condition     = module.cert_manager.namespace == "cert-manager"
    error_message = "cert-manager keeps leader election in its own namespace (GKE Autopilot)."
  }
}

run "project_repositories_live_in_the_cluster_forgejo" {
  command = plan
  variables {
    deployment = {
      revision = "0123456789abcdef0123456789abcdef01234567"
      env_file = "tests/fixtures/settings.env"
    }
  }
  assert {
    condition     = module.forgejo.url == "http://forgejo-http.azad.svc.cluster.local:3000"
    error_message = "The API reaches Forgejo inside the cluster, in the app's namespace."
  }
  assert {
    condition     = length(module.clerk_application) == 0
    error_message = "Without a recorded Clerk application, destroy leaves Clerk alone."
  }
}

run "an_evaluation_install_deletes_its_clerk_application_on_destroy" {
  command = plan
  variables {
    clerk_application = { id = "app_2fixture", delete_on_destroy = true }
  }
  assert {
    condition     = length(module.clerk_application) == 1
    error_message = "The setup's Clerk application is deleted with an evaluation install."
  }
}

run "disks_are_backed_up_on_the_chosen_schedule" {
  command = plan
  variables {
    disk_backups = { schedule = "hourly" }
  }
  assert {
    condition     = length(module.disk_backups) == 1
    error_message = "A schedule creates one Backup for GKE plan for the cluster."
  }
}

run "disk_backups_can_be_turned_off" {
  command = plan
  variables {
    disk_backups = { schedule = "off" }
  }
  assert {
    condition     = length(module.disk_backups) == 0
    error_message = "Off creates no backup plan."
  }
}

run "the_agent_machine_is_created_only_when_chosen" {
  command = plan
  assert {
    condition     = length(module.agent_machine) == 0
    error_message = "Without a choice no agent machine is created."
  }
}

run "a_chosen_agent_machine_runs_beside_the_cluster" {
  command = plan
  variables {
    agent_machine = { machine_type = "n2-custom-8-16384", label = "8 vCPU · 16 GB" }
  }
  override_resource {
    target          = module.gke.google_container_cluster.celld
    override_during = plan
    values = {
      subnetwork        = "projects/customer-project/regions/me-central1/subnetworks/default"
      cluster_ipv4_cidr = "10.80.0.0/17"
    }
  }
  assert {
    condition     = length(module.agent_machine) == 1
    error_message = "The chosen machine is created in the cluster's network."
  }
  assert {
    condition     = module.gke.network.pod_cidr == "10.80.0.0/17"
    error_message = "SSH to the machine is opened to the cluster's pod range only."
  }
}

run "the_api_may_ssh_into_the_cluster_subnet" {
  command = plan
  variables {
    deployment = {
      revision = "0123456789abcdef0123456789abcdef01234567"
      env_file = "tests/fixtures/settings.env"
    }
  }
  assert {
    condition     = module.app[0].ssh_allowed_private_cidrs == tolist(["10.212.0.0/20"])
    error_message = "The cluster's subnetwork range reaches the API as SSH_ALLOWED_PRIVATE_CIDRS."
  }
}

run "further_private_networks_join_the_cluster_subnet" {
  command = plan
  variables {
    deployment = {
      revision = "0123456789abcdef0123456789abcdef01234567"
      env_file = "tests/fixtures/settings.env"
    }
    ssh_allowed_private_cidrs = ["192.168.50.0/24", "10.212.0.0/20"]
  }
  assert {
    condition     = module.app[0].ssh_allowed_private_cidrs == tolist(["10.212.0.0/20", "192.168.50.0/24"])
    error_message = "Extra ranges follow the subnet range, de-duplicated."
  }
}

run "extra_ssh_networks_must_be_cidr_ranges" {
  command = plan
  variables {
    ssh_allowed_private_cidrs = ["10.0.0.1"]
  }
  expect_failures = [var.ssh_allowed_private_cidrs]
}
