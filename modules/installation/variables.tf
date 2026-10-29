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


variable "resource_prefix" {
  type = string
}
variable "database_url" {
  type      = string
  sensitive = true
}
variable "resources" {
  type = object({ buckets = map(string), queue_id = string, queue_name = string })
}

variable "database_ca_certificate_id" {
  description = "Resolved Terraform-owned public CA ID; null preserves explicit external CA configuration."
  type        = string
  default     = null
}

variable "storage" {
  description = "Non-secret object-storage selection passed to the installer; see the root module's storage variable."
  type = object({
    adapter         = optional(string, "r2")
    bucket          = optional(string)
    releases_bucket = optional(string)
    endpoint        = optional(string)
    region          = optional(string)
  })
  default  = {}
  nullable = false
}

variable "github_app_pending" {
  description = "Defers the installer's GitHub App verification while GITHUB_APP_* are placeholders."
  type        = bool
  default     = false
}

variable "source_dir" {
  description = "Absolute path of the Azad app source checkout (kodu-ai/azad-ide-web) whose scripts/self-host/cloudflare-install.ts deploys and uninstalls the app; its HEAD must be deployment.revision. Required when deployment.enabled; the drivers set it from --source."
  type        = string
  default     = null
}
