variable "domain" {
  description = "A domain name: a zone's apex, or a name inside a zone."
  type        = string
}

variable "account_id" {
  description = "The Cloudflare account whose zones are searched."
  type        = string
}
