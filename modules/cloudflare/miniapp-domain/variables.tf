variable "domain" {
  description = "The Mini Apps domain (AZAD_SELF_HOST_MINIAPP_BASE_DOMAIN): a zone of the account, or a subdomain inside one. Each Mini App serves on https://<label>.<domain>."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain))
    error_message = "Use a lowercase domain name such as apps.example.com."
  }
}

variable "account_id" {
  description = "The Cloudflare account whose zones are searched for the domain."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "Use a 32-character Cloudflare account ID."
  }
}

variable "installation" {
  description = "The installation's resource prefix, named in the DNS record's comment."
  type        = string
}
