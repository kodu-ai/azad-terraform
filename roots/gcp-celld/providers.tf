# Google credentials come from Application Default Credentials; Cloudflare from
# CLOUDFLARE_API_TOKEN. The Kubernetes provider is configured from the cluster
# created here, so a first install applies module.gke before everything else
# (scripts/gcp.ts does this).
provider "google" {
  project = var.project_id
  region  = var.region
}

provider "cloudflare" {}

data "google_client_config" "current" {}

provider "kubernetes" {
  host                   = module.gke.cluster.endpoint
  cluster_ca_certificate = module.gke.cluster.cluster_ca_certificate
  token                  = data.google_client_config.current.access_token
}

# Operators (cert-manager, the Cloud SQL Proxy Operator) and the custom
# resources they define install as Helm releases on the same cluster.
provider "helm" {
  kubernetes = {
    host                   = module.gke.cluster.endpoint
    cluster_ca_certificate = module.gke.cluster.cluster_ca_certificate
    token                  = data.google_client_config.current.access_token
  }
}
