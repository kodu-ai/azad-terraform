variable "zone_id" {
  description = "Cloudflare zone of the records."
  type        = string
}

variable "records" {
  description = "Records keyed by a stable label."
  type = map(object({
    name    = string
    type    = string
    content = string
    proxied = optional(bool, false)
  }))
}
