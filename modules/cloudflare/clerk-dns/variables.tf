variable "zone_id" {
  description = "Cloudflare zone containing the Clerk production domain."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.zone_id))
    error_message = "Use a 32-character Cloudflare zone ID."
  }
}

variable "records" {
  description = "Clerk CNAME targets: fully qualified record name to target hostname."
  type        = map(string)
  validation {
    condition     = alltrue([for name, target in var.records : can(regex("^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", name)) && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", target))])
    error_message = "Clerk DNS records must map hostnames to hostnames."
  }
}
