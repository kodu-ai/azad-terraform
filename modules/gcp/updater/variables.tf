variable "project_id" {
  description = "The installation's Google Cloud project."
  type        = string
}

variable "project_number" {
  description = "Its project number: Workload Identity principals and Secret Manager resource names use it."
  type        = string
  validation {
    condition     = can(regex("^[0-9]+$", var.project_number))
    error_message = "Use the numeric project number."
  }
}

variable "name" {
  description = "Installation name prefix (the root's var.name); custom role IDs derive from it."
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace of the fleets, where update Jobs run."
  type        = string
}

variable "image" {
  description = "The updater image, pinned by digest. The starter runs it and starts every update Job with the same image."
  type        = string
  validation {
    condition     = can(regex("^ghcr\\.io/kodu-ai/azad-updater@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use ghcr.io/kodu-ai/azad-updater@sha256:<digest>."
  }
}

variable "install_bucket" {
  description = "The installation's state bucket (scripts/state.ts gcpStore), which the drivers create and pass. The app's state is under install/, Terraform's under terraform/."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$", var.install_bucket))
    error_message = "Use a GCS bucket name."
  }
}

variable "api_service_account" {
  description = "Kubernetes service account of the API fleet, whose pods run the starter sidecar."
  type        = string
  default     = "azad-api"
}
