# Google credentials come from Application Default Credentials.
provider "google" {
  project = var.project_id
  region  = var.region
}
