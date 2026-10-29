variable "project_id" {
  description = "Existing billed Google Cloud project."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a Google Cloud project ID."
  }
}

variable "region" {
  description = "Region for the regional Autopilot cluster and the fleet bucket."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Installation name prefix for Google resources."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}[a-z0-9]$", var.name))
    error_message = "Use 3-26 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "namespace" {
  description = "Kubernetes namespace of the celld fleets."
  type        = string
  default     = "azad"
}

variable "fleet_service_accounts" {
  description = "Kubernetes service accounts (one per celld fleet) granted object access to the fleet bucket through Workload Identity; no keys exist."
  type        = list(string)
  default     = ["azad-api", "azad-web"]
}

variable "deletion_protection" {
  description = "Protect the cluster from accidental terraform destroy."
  type        = bool
  default     = true
}

variable "force_destroy" {
  description = "Let terraform destroy delete the fleet bucket with every deployment and all cell state in it. For evaluation installs only."
  type        = bool
  default     = false
}

variable "backup_agent" {
  description = "Enable the Backup for GKE agent, which scheduled disk backups (modules/gcp/gke-backup) need."
  type        = bool
  default     = false
}

variable "proxy_only_subnet_range" {
  description = "Range of the proxy-only subnet the regional load balancer's proxies use in the cluster's VPC and region (/26 or larger; /23 recommended). It must not overlap the VPC's other ranges; the default VPC's automatic subnets use 10.128.0.0/9. Null when the VPC already has an active proxy-only subnet in the region, for example a second installation there."
  type        = string
  default     = "10.127.0.0/23"
  validation {
    condition     = var.proxy_only_subnet_range == null || (can(cidrhost(var.proxy_only_subnet_range, 0)) && try(tonumber(split("/", var.proxy_only_subnet_range)[1]) <= 26, false))
    error_message = "Use a CIDR range of /26 or larger, such as 10.127.0.0/23, or null to use the region's existing proxy-only subnet."
  }
}
