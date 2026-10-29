# Own-infrastructure composition on Google Cloud: celld fleets on GKE Autopilot
# with state in GCS behind a regional GKE Gateway, Cloud SQL through the Cloud
# SQL Auth Proxy, Cloudflare for DNS (and optionally its proxy), and the app
# deployed by module.app. Both fleets use the cloud-neutral modules/celld/fleet.

locals {
  api_host  = "api.${var.web_host}"
  apps_host = "*.apps.${var.web_host}"
  routes = [
    { host = var.web_host, service = "azad-web", port = 80 },
    { host = local.api_host, service = "azad-api", port = 80 },
    { host = local.apps_host, service = "azad-api", port = 80 },
  ]
}

module "gke" {
  source                  = "../../modules/gcp/gke-celld"
  project_id              = var.project_id
  region                  = var.region
  name                    = var.name
  proxy_only_subnet_range = var.proxy_only_subnet_range
  deletion_protection     = var.deletion_protection
  backup_agent            = var.disk_backups.schedule != "off"
  # Without deletion protection, destroy also removes the deployments and cell state.
  force_destroy = !var.deletion_protection
}

resource "kubernetes_namespace_v1" "azad" {
  metadata {
    name = "azad"
  }
  # Destroy order: everything in the namespace, the namespace (which waits for
  # its pods, volume claims, the Gateway's load balancer and NEGs), the volume
  # wait, then module.gke: the load balancer's address and proxy-only subnet,
  # the cluster and the fleet bucket. Draining celld pods still write to the
  # bucket and need its IAM grant, so nothing in module.gke may go first.
  depends_on = [terraform_data.released_volumes, module.gke]
}

# Kubernetes deletes the disk behind a released volume claim asynchronously;
# a disk still pending when the cluster goes away is orphaned. On destroy this
# waits, after the namespace is gone, until no disk of the namespace remains.
resource "terraform_data" "released_volumes" {
  input = {
    project   = var.project_id
    region    = var.region
    namespace = "azad"
    cluster   = module.gke.cluster.name
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/bash", "-c"]
    environment = {
      PROJECT   = self.input.project
      REGION    = self.input.region
      NAMESPACE = self.input.namespace
    }
    command = <<-EOT
      command -v gcloud >/dev/null || { echo "gcloud is required to confirm released volumes are deleted before the cluster." >&2; exit 1; }
      for attempt in $(seq 1 60); do
        disks=$(gcloud compute disks list --project="$PROJECT" --filter="zone~$REGION" --format="value(name,description)") || exit 1
        remaining=$(printf '%s\n' "$disks" | grep -F "\"kubernetes.io/created-for/pvc/namespace\":\"$NAMESPACE\"" | cut -f1 | tr '\n' ' ')
        [ -z "$remaining" ] && exit 0
        echo "Waiting for Kubernetes to delete released volumes: $remaining"
        sleep 10
      done
      echo "Volumes still exist after 10 minutes: $remaining" >&2
      exit 1
    EOT
  }
}

locals {
  dns        = var.cloudflare_zone_id != null
  google_tls = local.dns && !var.cloudflare_proxy
  # Autopilot schedules these pods on amd64 nodes and taints by architecture.
  autopilot_tolerations = [{ key = "kubernetes.io/arch", value = "amd64", operator = "Equal", effect = "NoSchedule" }]
  node_principal        = "principal://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/azad/sa"
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "random_password" "database" {
  length  = 32
  special = false
}

# Cloud SQL keeps a deleted instance's name reserved for up to a week, so a
# reinstall after destroy needs a new one.
resource "random_id" "database" {
  byte_length = 2
}

module "database" {
  source = "../../modules/gcp/cloud-sql"
  settings = {
    project_id          = var.project_id
    region              = var.region
    instance_name       = "${var.name}-pg-${random_id.database.hex}"
    tier                = var.database.tier
    disk_size_gb        = var.database.disk_size_gb
    backups             = var.database.backups
    database_flags      = var.database.flags
    deletion_protection = var.deletion_protection
    authorized_networks = {}
    # The fleet's proxies may still be connected while destroy runs; deleting
    # the instance removes the database and user with it.
    deletion_policy = "ABANDON"
  }
  password = random_password.database.result
}

# The API fleet's Kubernetes service account connects through the proxy with
# its own IAM identity; no key or allowlisted network is involved.
resource "google_project_iam_member" "database_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "${local.node_principal}/azad-api"
}

# The Cloud SQL Auth Proxy comes from Google's Cloud SQL Proxy Operator, which
# needs cert-manager for its webhooks. Order: cert-manager, the operator, the
# AuthProxyWorkload, then the API fleet; destroy runs it backwards, so the
# AuthProxyWorkload's finalizer completes while the operator still runs.
module "cert_manager" {
  source = "../../modules/kubernetes/cert-manager"
}

module "cloud_sql_proxy_operator" {
  source     = "../../modules/gcp/cloud-sql-proxy-operator"
  depends_on = [module.cert_manager]
}

# Each azad-api pod gets the proxy as a sidecar on 127.0.0.1:5432, authorized
# by the pod's own Workload Identity (roles/cloudsql.client above). The Worker
# reaches it through the pod's PgBouncer (module.api).
module "database_proxy" {
  source    = "../../modules/kubernetes/manifests"
  name      = "azad-api-cloud-sql-proxy"
  namespace = kubernetes_namespace_v1.azad.metadata[0].name
  manifests = [{
    apiVersion = "cloudsql.cloud.google.com/v1"
    kind       = "AuthProxyWorkload"
    metadata = {
      name      = "azad-api"
      namespace = kubernetes_namespace_v1.azad.metadata[0].name
    }
    spec = {
      workloadSelector = { kind = "StatefulSet", name = "azad-api" }
      authProxyContainer = {
        resources = { requests = { cpu = "100m", memory = "128Mi" } }
      }
      instances = [{
        connectionString = module.database.connection.connection_name
        port             = 5432
      }]
    }
  }]
  depends_on = [module.cloud_sql_proxy_operator, google_project_iam_member.database_client]
}

module "certificates" {
  source     = "../../modules/gcp/certificates"
  count      = local.google_tls ? 1 : 0
  project_id = var.project_id
  region     = var.region
  name       = var.name
  domains    = [var.web_host, "apps.${var.web_host}"]
  # The load balancer's HTTPS proxy holds the certificate until the Gateway
  # controller removes it, which finishes before the namespace is gone.
  depends_on = [kubernetes_namespace_v1.azad]
}

# The domain-control records come first and on their own, so the certificate
# issues while the hostnames still point wherever they pointed before.
module "certificate_dns" {
  source  = "../../modules/cloudflare/dns-records"
  count   = local.google_tls ? 1 : 0
  zone_id = var.cloudflare_zone_id
  records = { for domain, record in module.certificates[0].dns_authorization_records : "acme ${domain}" => record }
}

module "gateway" {
  source         = "../../modules/gcp/gke-gateway"
  namespace      = kubernetes_namespace_v1.azad.metadata[0].name
  static_ip_name = module.gke.ingress_address.name
  tls            = local.dns && var.cloudflare_proxy ? module.edge[0].origin_tls : null
  certificates   = local.google_tls ? module.certificates[0].certificates : []
  routes         = local.routes
}

# DNS points the hostnames at the load balancer only once it serves each of
# them over HTTPS from healthy backends, with a valid certificate (Google's;
# Cloudflare's origin certificate is trusted by Cloudflare alone, so proxy mode
# checks the path only). Until then they keep their previous address, and a
# replaced Gateway keeps serving, so a new load balancer takes over without an
# outage. Its output is the address the records use. The Gateway's name orders
# it after the routes; depending on the whole module would also wait for the
# replaced Gateway's removal, which waits for this check.
resource "terraform_data" "load_balancer_ready" {
  count = local.dns ? 1 : 0
  input = module.gke.ingress_address.address
  triggers_replace = [
    module.gke.ingress_address.address,
    module.gateway.name,
    local.google_tls ? module.certificates[0].certificates : [],
  ]

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      ADDRESS  = self.input
      HOSTS    = join(" ", [var.web_host, local.api_host, "ready.apps.${var.web_host}"])
      CURL_TLS = var.cloudflare_proxy ? "--insecure" : ""
      MINUTES  = var.ready_timeout_minutes
    }
    command = <<-EOT
      command -v curl >/dev/null || { echo "curl is required to confirm the load balancer serves before DNS moves to it." >&2; exit 1; }
      deadline=$(( $(date +%s) + MINUTES * 60 ))
      while :; do
        waiting=""
        for host in $HOSTS; do
          status=$(curl $CURL_TLS --silent --output /dev/null --write-out '%%{http_code}' --max-time 10 --resolve "$host:443:$ADDRESS" "https://$host/.well-known/celld/health") || true
          [ "$status" = 200 ] || waiting="$waiting $host ($status)"
        done
        [ -z "$waiting" ] && exit 0
        if [ "$(date +%s)" -ge "$deadline" ]; then
          echo "The load balancer at $ADDRESS does not serve yet:$waiting. DNS is unchanged; apply again to keep waiting." >&2
          exit 1
        fi
        echo "Waiting for the load balancer at $ADDRESS (certificate, routes and healthy backends):$waiting"
        sleep 20
      done
    EOT
  }

  depends_on = [module.certificate_dns, module.api, module.web]
}

module "dns" {
  source  = "../../modules/cloudflare/dns-records"
  count   = local.google_tls ? 1 : 0
  zone_id = var.cloudflare_zone_id
  records = { for host in [var.web_host, local.api_host, local.apps_host] : host => {
    name    = host
    type    = "A"
    content = terraform_data.load_balancer_ready[0].output
  } }
}

module "edge" {
  source          = "../../modules/cloudflare/edge"
  count           = local.dns && var.cloudflare_proxy ? 1 : 0
  zone_id         = var.cloudflare_zone_id
  hosts           = [var.web_host, local.api_host, local.apps_host]
  origin_address  = terraform_data.load_balancer_ready[0].output
  manage_ssl_rule = var.manage_ssl_rule
}

module "api" {
  source    = "../../modules/celld/fleet"
  name      = "azad-api"
  namespace = kubernetes_namespace_v1.azad.metadata[0].name
  replicas  = var.api_replicas
  bucket    = "gs://${module.gke.bucket}/api"
  service   = { annotations = module.gateway.service_annotations["azad-api"] }
  spot      = var.spot
  # Autopilot schedules these pods on amd64 nodes and taints by architecture.
  tolerations = local.autopilot_tolerations
  resources   = { cpu_request = "500m", memory_request = "1536Mi", memory_limit = "1536Mi" }
  # The Worker connects to PgBouncer on 127.0.0.1:6432 in its pod, which keeps
  # warm connections to PostgreSQL through the Cloud SQL Auth Proxy on
  # 127.0.0.1:5432. Without it every request opened a new Cloud SQL connection
  # (TLS through the proxy, authentication and a server process each time).
  database_pooler = {
    database = module.database.connection.database
    username = module.database.connection.username
    # The default tier allows 100 connections; 80 across the fleet leaves room
    # for migrations and Cloud SQL's reserved ones. Every advisory-lock owner
    # holds one for as long as it holds or waits for its lock, so the pool is
    # sized generously (see the pooler's description).
    pool_size = floor(80 / var.api_replicas)
  }
  database_pooler_password = random_password.database.result
  # The proxy is injected into these pods by the operator
  # (module.database_proxy), so that must exist before the first pod is created.
  depends_on = [module.database_proxy]
}

module "web" {
  source      = "../../modules/celld/fleet"
  name        = "azad-web"
  namespace   = kubernetes_namespace_v1.azad.metadata[0].name
  replicas    = 1
  bucket      = "gs://${module.gke.bucket}/web"
  service     = { annotations = module.gateway.service_annotations["azad-web"] }
  spot        = var.spot
  tolerations = local.autopilot_tolerations
  resources   = { cpu_request = "250m", memory_request = "512Mi", memory_limit = "512Mi" }
}

# Managed project repositories: the official Forgejo Helm chart inside the
# cluster, reached only by the API (Cloudflare Artifacts stays the Cloudflare
# target's host). Its volume is a disk in namespace "azad", so destroy waits
# for it with the API's.
module "forgejo" {
  source      = "../../modules/kubernetes/forgejo"
  namespace   = kubernetes_namespace_v1.azad.metadata[0].name
  spot        = var.spot
  tolerations = local.autopilot_tolerations
}

# Scheduled snapshots of the app namespace's disks, chosen at setup: Forgejo
# keeps its repositories on a single disk, so this is their backup.
locals {
  disk_backup_cron = {
    hourly = "0 * * * *"
    daily  = "0 3 * * *"
    weekly = "0 3 * * 0"
  }
  disk_backup_retain_days = {
    hourly = 2
    daily  = 7
    weekly = 28
  }
}

module "disk_backups" {
  source        = "../../modules/gcp/gke-backup"
  count         = var.disk_backups.schedule == "off" ? 0 : 1
  project_id    = var.project_id
  location      = var.region
  cluster_id    = module.gke.cluster.id
  name          = "${var.name}-disks"
  namespace     = kubernetes_namespace_v1.azad.metadata[0].name
  cron_schedule = local.disk_backup_cron[var.disk_backups.schedule]
  retain_days   = coalesce(var.disk_backups.retain_days, local.disk_backup_retain_days[var.disk_backups.schedule])
  # An evaluation install removes everything, its backups included.
  delete_backups_on_destroy = !var.deletion_protection
}

# The Clerk application the setup created; an evaluation install deletes it on
# destroy with everything else (the setup decides, see var.clerk_application).
module "clerk_application" {
  source      = "../../modules/clerk/application"
  count       = var.clerk_application == null ? 0 : 1
  application = var.clerk_application
}

module "clerk_dns" {
  source  = "../../modules/cloudflare/clerk-dns"
  count   = var.clerk_dns == null ? 0 : 1
  zone_id = try(var.clerk_dns.zone_id, "")
  records = try(var.clerk_dns.records, {})
}

# A machine for agents, reached from the API pods over SSH on its internal
# address. People connect it in project setup as "A server over SSH" with the
# agent_machine outputs.
module "agent_machine" {
  source              = "../../modules/gcp/agent-machine"
  count               = var.agent_machine == null ? 0 : 1
  project_id          = var.project_id
  region              = var.region
  name                = var.name
  machine_type        = var.agent_machine.machine_type
  disk_size_gb        = var.agent_machine.disk_size_gb
  network             = module.gke.network.network
  subnetwork          = module.gke.network.subnetwork
  ssh_source_ranges   = [module.gke.network.pod_cidr]
  deletion_protection = var.deletion_protection
}

# The cluster's subnetwork, where the agent machine and other VMs the API pods
# reach over internal addresses live. Its primary range is passed to the API
# as SSH_ALLOWED_PRIVATE_CIDRS so project setup can connect them by IP.
data "google_compute_subnetwork" "cluster" {
  project = var.project_id
  region  = var.region
  name    = basename(module.gke.network.subnetwork)
}

# The app itself: instance keys, migrations, the Agent Connect release mirror
# and both bundles, deployed into the fleets once everything they need exists.
module "app" {
  source     = "../../modules/celld/app"
  count      = var.deployment == null ? 0 : 1
  deployment = var.deployment
  source_dir = var.source_dir
  fleets = {
    api = module.api.bucket
    web = module.web.bucket
  }
  origins = {
    web = "https://${var.web_host}"
    api = "https://${local.api_host}"
  }
  miniapp_base_domain = "apps.${var.web_host}"
  database = {
    # The pod's PgBouncer; behind it the Cloud SQL Auth Proxy sidecar adds TLS
    # and IAM authorization. Migrations use their own local proxy instead.
    url                = "postgresql://${module.database.connection.username}:${urlencode(random_password.database.result)}@${module.api.database_endpoint}/${module.database.connection.database}?sslmode=disable"
    cloud_sql_instance = module.database.connection.connection_name
  }
  managed_git = {
    url      = module.forgejo.url
    username = module.forgejo.username
    password = module.forgejo.password
  }
  ready_timeout_minutes = var.ready_timeout_minutes
  ssh_allowed_private_cidrs = distinct(concat(
    [data.google_compute_subnetwork.cluster.ip_cidr_range],
    var.ssh_allowed_private_cidrs,
  ))

  depends_on = [
    module.gke,
    module.forgejo,
    module.gateway,
    module.dns,
    module.edge,
    module.clerk_dns,
    google_project_iam_member.database_client,
  ]
}
