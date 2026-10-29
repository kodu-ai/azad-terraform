variable "deployment" {
  description = "Installer handoff. revision is the exact checked-out commit; env_file is the installer's private dotenv (Clerk, GitHub App, optional settings), read only by the deploy script and never stored in Terraform state; state_directory keeps the instance keys, tools and log. The drivers write absolute paths in the instance directory; a relative path is relative to the Terraform root directory."
  type = object({
    revision        = string
    env_file        = string
    state_directory = optional(string, ".celld-install")
  })
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.deployment.revision)) && length(var.deployment.env_file) > 0 && length(var.deployment.state_directory) > 0
    error_message = "Provide an exact 40-character Git revision, the installer dotenv file and a persistent state directory."
  }
}

variable "fleets" {
  description = "Fleet buckets (celld/fleet outputs) of the API and web fleets. The deploying machine reaches them with its own credentials (Application Default Credentials for gs://)."
  type = object({
    api = string
    web = string
  })
}

variable "origins" {
  description = "Public HTTPS origins of the web client and the API."
  type = object({
    web = string
    api = string
  })
  validation {
    condition     = alltrue([for origin in [var.origins.web, var.origins.api] : can(regex("^https://[a-z0-9]+([.-][a-z0-9]+)+$", origin))]) && var.origins.web != var.origins.api
    error_message = "Use distinct lowercase HTTPS origins without ports, paths or trailing slashes."
  }
}

variable "miniapp_base_domain" {
  description = "Mini App backends serve on <app>.<miniapp_base_domain> through the API fleet (loader provider)."
  type        = string
}

variable "database" {
  description = "url: the DSN as the Worker reaches PostgreSQL from its pod. cloud_sql_instance: Cloud SQL connection name; migrations then run through a local Cloud SQL Auth Proxy with url's user, password and database. Without it the deploying machine must reach url itself."
  sensitive   = true
  type = object({
    url                = string
    cloud_sql_instance = optional(string)
  })
}

variable "ready_timeout_minutes" {
  description = "How long the deploy waits for the API origin to serve the new revision. A first install includes load balancer creation and managed certificate issuance."
  type        = number
  default     = 45
}

variable "managed_git" {
  description = "The installation's own Forgejo for managed project repositories (modules/kubernetes/forgejo outputs): in-cluster URL and the service account the API uses. Null keeps Cloudflare Artifacts."
  sensitive   = true
  type = object({
    url      = string
    username = string
    password = string
  })
  default = null
}

variable "ssh_allowed_private_cidrs" {
  description = "Private networks the API may SSH into for every project (SSH_ALLOWED_PRIVATE_CIDRS): CIDR ranges inside 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 or fc00::/7, checked again by the deploy script. Empty allows none."
  type        = list(string)
  default     = []
}

variable "source_dir" {
  description = "Absolute path of the Azad app source checkout (kodu-ai/azad-ide-web) whose scripts/self-host/celld-install.ts deploys the app; its HEAD must be deployment.revision. The drivers set it from --source."
  type        = string
  default     = null
}
