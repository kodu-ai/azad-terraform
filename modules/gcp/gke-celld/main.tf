# GCP base for the own-infrastructure target: a regional GKE Autopilot cluster
# for the celld fleets, one private GCS bucket for fleet state, and the static
# IP and proxy-only subnet of the regional external Application Load Balancer.
# celld reaches the bucket with Application Default Credentials from GKE
# Workload Identity, so no storage keys are created.

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_service" "required" {
  for_each = toset([
    "compute.googleapis.com",
    "container.googleapis.com",
    "storage.googleapis.com",
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_container_cluster" "celld" {
  project             = var.project_id
  name                = "${var.name}-celld"
  location            = var.region
  enable_autopilot    = true
  deletion_protection = var.deletion_protection

  release_channel {
    channel = "REGULAR"
  }
  ip_allocation_policy {}
  # The fleets are reached through a regional GKE Gateway.
  gateway_api_config {
    channel = "CHANNEL_STANDARD"
  }
  addons_config {
    gke_backup_agent_config {
      enabled = var.backup_agent
    }
  }

  depends_on = [google_project_service.required]
}

resource "random_id" "bucket" {
  byte_length = 4
}

# celld needs conditional writes and ranged reads, which GCS provides through
# generation preconditions. No versioning or soft delete: celld manages its own
# epochs, and retained deletions would only add cost.
resource "google_storage_bucket" "fleet" {
  project                     = var.project_id
  name                        = "${var.name}-fleet-${random_id.bucket.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.force_destroy

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  depends_on = [google_project_service.required]
}

# Direct Workload Identity Federation for GKE: the Kubernetes service account
# itself is the principal; no Google service account or key is involved.
resource "google_storage_bucket_iam_member" "fleet" {
  for_each = toset(var.fleet_service_accounts)
  bucket   = google_storage_bucket.fleet.name
  role     = "roles/storage.objectUser"
  member   = "principal://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/${var.namespace}/sa/${each.value}"

  depends_on = [google_container_cluster.celld]
}

# The regional external Application Load Balancer terminates TLS in the
# cluster's region, so a request pays the round trip to the region once instead
# of to a distant edge proxy and back. Premium Tier carries it over Google's
# network from the nearest point of presence.
resource "google_compute_address" "ingress" {
  project      = var.project_id
  region       = var.region
  name         = "${var.name}-ingress"
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"

  depends_on = [google_project_service.required]
}

# Regional Envoy load balancers run their proxies in the region's proxy-only
# subnet. A VPC holds one active subnet per region, shared by every regional
# load balancer in it; null uses the one that already exists. It follows the
# cluster, so a range that overlaps the pod range GKE picked fails here, on
# its own, rather than the cluster's creation.
resource "google_compute_subnetwork" "proxy_only" {
  count         = var.proxy_only_subnet_range == null ? 0 : 1
  project       = var.project_id
  region        = var.region
  name          = "${var.name}-proxy-only"
  network       = local.network
  ip_cidr_range = var.proxy_only_subnet_range
  purpose       = "REGIONAL_MANAGED_PROXY"
  role          = "ACTIVE"

  depends_on = [google_container_cluster.celld]
}

# The cluster sets no network, so GKE puts it on the project's default VPC.
locals {
  network = "default"
}
