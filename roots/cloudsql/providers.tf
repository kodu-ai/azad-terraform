# Credentials come from Google ADC and CLOUDFLARE_API_TOKEN, never HCL.
provider "google" {
  project = var.gcp.project_id
  region  = var.gcp.region
}

provider "cloudflare" {}
