variable "database_url" {
  description = "Customer-supplied direct PostgreSQL DSN. The database lifecycle remains outside this composition."
  type        = string
  sensitive   = true
  validation {
    condition     = can(regex("^postgres(ql)?://[^\\s]+[?]sslmode=(require|verify-full)$", var.database_url))
    error_message = "Supply a direct PostgreSQL DSN with explicit TLS; use verify-full for a publicly trusted certificate."
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

variable "database_ca" {
  description = "Optional Terraform-owned public CA registration for a direct Neon endpoint. Existing CA IDs remain in the private installer file."
  type        = string
  default     = null
  validation {
    condition     = var.database_ca == null || var.database_ca == "neon-isrg-root-x1"
    error_message = "The supported managed CA is neon-isrg-root-x1."
  }
  validation {
    condition = var.database_ca == null || (
      can(regex("^postgres(ql)?://[^@]+@ep-[a-z0-9-]+\\.[a-z0-9.-]+\\.neon\\.tech(:[0-9]+)?/[^?]+\\?sslmode=verify-full$", var.database_url)) &&
      !can(regex("@[^.]*-pooler\\.", var.database_url))
    )
    error_message = "Managed Neon CA registration requires a direct neon.tech endpoint with sslmode=verify-full."
  }
}

variable "database_ca_pem" {
  description = "Public CA exported from the deployment runner's OS trust store; supplied by scripts/cloudflare.ts at plan, apply and destroy."
  type        = string
  default     = ""
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
  description = "Absolute path of the Azad app source checkout (kodu-ai/azad-ide-web) whose scripts/self-host entrypoints deploy and uninstall the app; its HEAD must be deployment.revision. The drivers set it from --source (TF_VAR_source_dir). Required to deploy; plans without a deployment need none."
  type        = string
  default     = null
  validation {
    condition     = startswith(coalesce(var.source_dir, "/"), "/")
    error_message = "Use an absolute path to the Azad source checkout."
  }
}
