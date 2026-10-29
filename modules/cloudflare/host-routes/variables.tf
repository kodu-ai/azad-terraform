variable "hosts" {
  description = "Board hostname (API and web) to the ID of the Cloudflare zone that serves it."
  type        = map(string)
  validation {
    condition     = alltrue([for host, zone in var.hosts : can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", host)) && can(regex("^[a-f0-9]{32}$", zone))])
    error_message = "Map lowercase hostnames to 32-character Cloudflare zone IDs."
  }
}
