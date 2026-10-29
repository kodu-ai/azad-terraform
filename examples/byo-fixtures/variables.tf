variable "project_id" {
  description = "Google Cloud project that holds the simulated customer-owned database and bucket."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a Google Cloud project ID."
  }
}

variable "region" {
  description = "Region of the Cloud SQL instance and the bucket."
  type        = string
  default     = "me-central1"
}

variable "name_prefix" {
  description = "Prefix of every fixture resource; keeps fixtures apart from other installations in the project."
  type        = string
  default     = "azad-cftest"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,18}[a-z0-9]$", var.name_prefix))
    error_message = "Use 4-20 lowercase letters, digits or hyphens."
  }
}

variable "runner_cidr" {
  description = "IPv4 CIDR of the machine that runs migrations. Empty detects this machine's public IPv4."
  type        = string
  default     = ""
  validation {
    condition     = var.runner_cidr == "" || can(cidrnetmask(var.runner_cidr))
    error_message = "Use an IPv4 CIDR such as 203.0.113.7/32."
  }
}

variable "env_file" {
  description = "Private dotenv (mode 0600) that receives DATABASE_URL and the STORAGE_* settings a customer would bring."
  type        = string
}
