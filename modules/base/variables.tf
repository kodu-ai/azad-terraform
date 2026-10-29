variable "gcp" {
  description = "Existing customer project and Cloud SQL settings. Include Hyperdrive egress AND migration runner IPv4 CIDRs."
  type = object({
    project_id          = string
    region              = optional(string, "me-central2")
    instance_name       = optional(string)
    tier                = optional(string, "db-custom-2-7680")
    availability_type   = optional(string, "ZONAL")
    disk_size_gb        = optional(number, 20)
    deletion_protection = optional(bool, true)
    database_name       = optional(string, "azad")
    username            = optional(string, "azad")
    authorized_networks = map(string)
    labels              = optional(map(string), {})
  })
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.gcp.project_id)) && (var.gcp.instance_name == null ? true : (can(regex("^[a-z][a-z0-9-]{0,96}[a-z0-9]$", var.gcp.instance_name)) && length("${var.gcp.project_id}:${var.gcp.instance_name}") <= 98))
    error_message = "Use valid GCP project and Cloud SQL instance IDs; project_id:instance_name must fit within 98 characters."
  }
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.gcp.region)) && can(regex("^db-custom-[0-9]+-[0-9]+$", var.gcp.tier))
    error_message = "Use a GCP region and an Enterprise custom tier such as db-custom-2-7680."
  }
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.gcp.availability_type) && var.gcp.disk_size_gb >= 10 && floor(var.gcp.disk_size_gb) == var.gcp.disk_size_gb
    error_message = "Availability must be ZONAL or REGIONAL; disk size must be a whole number of at least 10 GB."
  }
  validation {
    condition     = alltrue([for name in [var.gcp.database_name, var.gcp.username] : can(regex("^[a-z][a-z0-9_]{0,62}$", name))])
    error_message = "Database and username must be lowercase PostgreSQL identifiers, at most 63 characters."
  }
  validation {
    condition     = length(var.gcp.authorized_networks) > 0 && alltrue([for cidr in values(var.gcp.authorized_networks) : can(cidrnetmask(cidr))])
    error_message = "Provide named IPv4 CIDRs for Hyperdrive egress and the migration runner."
  }
}

variable "database_password" {
  description = "Cloud SQL application/migration user password, generated and retained in state when omitted. An optional override comes from TF_VAR_database_password."
  type        = string
  sensitive   = true
  default     = null
  validation {
    condition     = var.database_password == null ? true : length(var.database_password) > 0
    error_message = "Supply a nonempty database password."
  }
}

variable "cloudflare" {
  description = "Existing customer Cloudflare account and two hosts in zones it owns. API origin also fixes resource names."
  type = object({
    account_id = string
    api_origin = string
    web_origin = string
  })
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare.account_id))
    error_message = "Use a 32-character Cloudflare account ID."
  }
  validation {
    condition     = var.cloudflare.api_origin != var.cloudflare.web_origin && alltrue([for origin in [var.cloudflare.api_origin, var.cloudflare.web_origin] : can(regex("^https://[a-z0-9]+([.-][a-z0-9]+)+$", origin))])
    error_message = "Use distinct lowercase HTTPS DNS origins without ports, paths or trailing slashes."
  }
}

variable "deployment" {
  description = "Installer handoff. The drivers write absolute paths in the instance directory; a relative path is relative to the Terraform root directory. Set enabled=false for infrastructure only."
  type = object({
    enabled         = optional(bool, true)
    env_file        = optional(string, ".env.self-host")
    revision        = string
    state_directory = optional(string, ".installer-state")
  })
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.deployment.revision)) && length(var.deployment.env_file) > 0 && length(var.deployment.state_directory) > 0
    error_message = "Provide an exact 40-character Git revision, selected installer dotenv file and persistent installer state directory."
  }
}

variable "storage" {
  description = "Object storage for uploaded files and the Agent Connect release mirror. adapter = \"r2\" (default) creates this installation's two R2 buckets. \"s3\" or \"gcs\" uses your existing bucket and creates no R2 bucket: bucket is required, releases_bucket defaults to it, s3 needs region and takes an HTTPS endpoint for S3-compatible services. The access keys stay in the private installer file as STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY."
  type = object({
    adapter         = optional(string, "r2")
    bucket          = optional(string)
    releases_bucket = optional(string)
    endpoint        = optional(string)
    region          = optional(string)
  })
  default  = {}
  nullable = false
  validation {
    condition     = contains(["r2", "s3", "gcs"], var.storage.adapter)
    error_message = "storage.adapter must be r2, s3 or gcs."
  }
  validation {
    condition = (var.storage.adapter == "r2"
      ? alltrue([for value in [var.storage.bucket, var.storage.releases_bucket, var.storage.endpoint, var.storage.region] : value == null])
      : can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.storage.bucket)) && (var.storage.releases_bucket == null || can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.storage.releases_bucket)))
    )
    error_message = "With adapter r2 leave the other storage fields unset; with s3 or gcs name an existing bucket (bucket names only, no URL)."
  }
  validation {
    condition = (var.storage.adapter == "s3" ? var.storage.region != null
      : var.storage.adapter == "gcs" ? var.storage.endpoint == null && var.storage.region == null
    : true)
    error_message = "s3 needs a region; gcs uses Google's endpoint and takes neither endpoint nor region."
  }
  validation {
    condition     = var.storage.endpoint == null || can(regex("^https://[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?$", var.storage.endpoint))
    error_message = "storage.endpoint must be one HTTPS origin without a path."
  }
}

variable "github_app_pending" {
  description = "Deploy before the GitHub App exists: the installer skips only GitHub's App identity check and the GITHUB_APP_* placeholders in the installer file are deployed as they are. GitHub sign-in, repositories and webhooks do not work until the real App's values replace them and this is set back to false. Default false."
  type        = bool
  default     = false
  nullable    = false
}

variable "clerk_dns" {
  description = "Clerk production-domain CNAMEs created in its Cloudflare zone. Setup derives them from the Clerk secret key; null when Clerk DNS is managed elsewhere."
  type = object({
    zone_id = string
    records = map(string)
  })
  default = null
}

variable "host_zones" {
  description = "Zone ID of each Board hostname (API and web). Terraform reserves these hostnames from other Workers routes in the zones (for example a zone-wide \"*.example.com/*\") so they cannot capture the API or web host. Setup fills it; empty reserves nothing."
  type        = map(string)
  default     = {}
  nullable    = false
}

variable "source_dir" {
  description = "Absolute path of the Azad app source checkout that deploys and uninstalls the app (see modules/installation)."
  type        = string
  default     = null
}
