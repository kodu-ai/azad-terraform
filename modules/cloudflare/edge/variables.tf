variable "zone_id" {
  description = "Cloudflare zone that contains the hostnames."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.zone_id))
    error_message = "Use a 32-character Cloudflare zone ID."
  }
}

variable "hosts" {
  description = "Hostnames served through Cloudflare to the origin, for example the web host, api host and *.apps.<web host>."
  type        = list(string)
  validation {
    condition     = length(var.hosts) > 0 && alltrue([for host in var.hosts : can(regex("^(\\*\\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", host))])
    error_message = "Use lowercase hostnames; only a leading *. wildcard is allowed."
  }
}

variable "api_host" {
  description = "The API's hostname, one of hosts. Its signed file, handoff and artifact links skip Browser Integrity Check."
  type        = string
  validation {
    condition     = contains(var.hosts, var.api_host) && !startswith(var.api_host, "*.")
    error_message = "Use the API's exact hostname from hosts."
  }
}

variable "origin_address" {
  description = "Public IPv4 address of the origin load balancer."
  type        = string
}

variable "manage_ssl_rule" {
  description = "Create the zone's Configuration Rules entrypoint with Full (strict) TLS for these hosts and Browser Integrity Check off for the API's signed links. A zone has one entrypoint per phase: set false when it already has Configuration Rules, and add both rules there (or set Full (strict) zone-wide) instead."
  type        = bool
  default     = true
}
