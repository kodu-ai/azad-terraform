variable "settings" {
  description = "Existing customer project and Cloud SQL settings. Direct clients (Hyperdrive, migration runner) need authorized IPv4 CIDRs; with none, only IAM-authorized Cloud SQL Auth Proxy connections reach the instance."
  type = object({
    project_id          = string
    region              = optional(string, "me-central2")
    instance_name       = string
    tier                = optional(string, "db-custom-2-7680")
    availability_type   = optional(string, "ZONAL")
    disk_size_gb        = optional(number, 20)
    deletion_protection = optional(bool, true)
    database_name       = optional(string, "azad")
    username            = optional(string, "azad")
    authorized_networks = map(string)
    labels              = optional(map(string), {})
    backups             = optional(bool, true)
    # Azad's schema migrations lock many relations in one transaction; small
    # tiers allow few connections, which shrinks the shared lock table, so
    # small tiers need max_locks_per_transaction raised (for example 1024).
    database_flags = optional(map(string), {})
    # ABANDON leaves the database and user to the instance's own deletion, so
    # destroy does not fail on clients that still hold connections.
    deletion_policy = optional(string, "DELETE")
  })
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.settings.project_id)) && can(regex("^[a-z][a-z0-9-]{0,96}[a-z0-9]$", var.settings.instance_name)) && length("${var.settings.project_id}:${var.settings.instance_name}") <= 98
    error_message = "Use valid GCP project and Cloud SQL instance IDs; project_id:instance_name must fit within 98 characters."
  }
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.settings.region)) && can(regex("^(db-custom-[0-9]+-[0-9]+|db-f1-micro|db-g1-small)$", var.settings.tier))
    error_message = "Use a GCP region and an Enterprise tier such as db-custom-2-7680; db-f1-micro and db-g1-small are shared-core tiers for evaluation."
  }
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.settings.availability_type) && var.settings.disk_size_gb >= 10 && floor(var.settings.disk_size_gb) == var.settings.disk_size_gb
    error_message = "Availability must be ZONAL or REGIONAL; disk size must be a whole number of at least 10 GB."
  }
  validation {
    condition     = alltrue([for name in [var.settings.database_name, var.settings.username] : can(regex("^[a-z][a-z0-9_]{0,62}$", name))])
    error_message = "Database and username must be lowercase PostgreSQL identifiers, at most 63 characters."
  }
  validation {
    condition     = contains(["DELETE", "ABANDON"], var.settings.deletion_policy)
    error_message = "deletion_policy is DELETE or ABANDON."
  }
  validation {
    condition     = alltrue([for cidr in values(var.settings.authorized_networks) : can(cidrnetmask(cidr))])
    error_message = "Provide named IPv4 CIDRs, or none when every client connects through the Cloud SQL Auth Proxy."
  }
}

variable "password" {
  description = "Cloud SQL application/migration user password, supplied through TF_VAR_database_password. Stored in Terraform state."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.password) > 0
    error_message = "Supply a nonempty database password."
  }
}
