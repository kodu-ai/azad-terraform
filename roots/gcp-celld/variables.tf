variable "project_id" {
  description = "Existing billed Google Cloud project."
  type        = string
}

variable "region" {
  description = "Region for the cluster and fleet bucket."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Installation name prefix for Google resources."
  type        = string
  default     = "azad"
}

variable "web_host" {
  description = "Browser hostname; the API is api.<web_host> and Mini Apps are <app>.apps.<web_host>."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.web_host))
    error_message = "Use a lowercase hostname such as board.example.com."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone of the hostnames. Null leaves DNS unmanaged and serves plain HTTP on the load balancer IP (evaluation only)."
  type        = string
  default     = null
}

variable "cloudflare_proxy" {
  description = "Proxy the hostnames through Cloudflare (Origin CA certificate on the load balancer). Hostnames deeper than one subdomain level need Cloudflare Advanced Certificate Manager. False keeps Cloudflare as DNS only with Google-managed certificates, which cover any depth."
  type        = bool
  default     = false
}

variable "proxy_only_subnet_range" {
  description = "Range of the proxy-only subnet the regional load balancer's proxies use in the default VPC and the region: /26 or larger, outside the VPC's other ranges (its automatic subnets use 10.128.0.0/9). Null when the VPC already has an active proxy-only subnet in the region, for example from another installation there."
  type        = string
  default     = "10.127.0.0/23"
}

variable "manage_ssl_rule" {
  description = "With cloudflare_proxy: create the zone's Full (strict) Configuration Rule; false when the zone already has Configuration Rules."
  type        = bool
  default     = true
}

variable "api_replicas" {
  description = "API fleet nodes."
  type        = number
  default     = 2
}

variable "deletion_protection" {
  description = "Protect the cluster and database from terraform destroy. False (evaluation) lets destroy remove everything, including the fleet bucket's deployments and cell state."
  type        = bool
  default     = true
}

variable "deployment" {
  description = "Deploy the app after provisioning: the Azad source checkout's exact revision (its HEAD, see source_dir) and the installer's private dotenv (Clerk keys; GitHub App and optional settings when configured), which stays out of Terraform state. state_directory keeps the instance keys; back it up. scripts/gcp.ts writes both as paths in the instance directory. Null provisions infrastructure only."
  type = object({
    revision        = string
    env_file        = string
    state_directory = optional(string, ".celld-install")
  })
  default = null
  validation {
    condition     = var.deployment == null || var.cloudflare_zone_id != null
    error_message = "Deploying the app needs its HTTPS origins: set cloudflare_zone_id."
  }
}

variable "ready_timeout_minutes" {
  description = "How long DNS waits for a new load balancer to serve (certificate issuance included), and how long a deploy waits for the API origin to serve the new revision."
  type        = number
  default     = 45
}

variable "clerk_dns" {
  description = "Clerk production-domain CNAMEs derived by setup; null when Clerk DNS is managed elsewhere."
  type = object({
    zone_id = string
    records = map(string)
  })
  default = null
}

variable "spot" {
  description = "Run celld nodes on Spot capacity: much cheaper, preemptible. celld tolerates node loss; use for evaluation."
  type        = bool
  default     = false
}

variable "database" {
  description = "Cloud SQL for PostgreSQL. Only the Cloud SQL Auth Proxy (IAM-authorized) reaches it; no networks are allowlisted."
  type = object({
    tier         = optional(string, "db-custom-1-3840")
    disk_size_gb = optional(number, 10)
    backups      = optional(bool, true)
    # Migrations lock many relations per transaction; small tiers need more lock slots.
    flags = optional(map(string), { max_locks_per_transaction = "1024" })
  })
  default = {}
}

variable "clerk_application" {
  description = "The Clerk application the setup created. With delete_on_destroy (evaluation installs), destroy deletes it and every user account in it through the setup's Clerk CLI login. Null leaves Clerk alone."
  type = object({
    id                = string
    delete_on_destroy = bool
  })
  default = null
}

variable "disk_backups" {
  description = "Scheduled Backup for GKE snapshots of the app namespace's disks (Forgejo's repositories and celld's state): hourly, daily, weekly or off. retain_days defaults to 2, 7 and 28 days respectively."
  type = object({
    schedule    = optional(string, "daily")
    retain_days = optional(number)
  })
  default = {}
  validation {
    condition     = contains(["hourly", "daily", "weekly", "off"], var.disk_backups.schedule)
    error_message = "Use hourly, daily, weekly or off."
  }
}

variable "agent_machine" {
  description = "One Compute Engine machine for agents (modules/gcp/agent-machine), connected in project setup as \"A server over SSH\" with the agent_machine outputs. label describes its size, e.g. \"8 vCPU · 16 GB\". Null creates none."
  type = object({
    machine_type = string
    label        = string
    disk_size_gb = optional(number, 100)
  })
  default = null
}

variable "ssh_allowed_private_cidrs" {
  description = "Further private networks the API may SSH into, as CIDR ranges inside 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 or fc00::/7 (for example a peered VPC). The cluster's own subnetwork range is always allowed; these are added to it as SSH_ALLOWED_PRIVATE_CIDRS."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for range in var.ssh_allowed_private_cidrs : can(cidrhost(range, 0))])
    error_message = "Each entry must be a CIDR range such as 10.20.0.0/16."
  }
}

variable "source_dir" {
  description = "Absolute path of the Azad app source checkout (kodu-ai/azad-ide-web) whose scripts/self-host/celld-install.ts deploys the app; its HEAD must be deployment.revision. The drivers set it from --source (TF_VAR_source_dir). Required with a deployment."
  type        = string
  default     = null
  validation {
    condition     = startswith(coalesce(var.source_dir, "/"), "/")
    error_message = "Use an absolute path to the Azad source checkout."
  }
}
