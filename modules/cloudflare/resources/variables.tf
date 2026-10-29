variable "account_id" {
  description = "Customer Cloudflare account ID."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "Use a 32-character Cloudflare account ID."
  }
}

variable "api_origin" {
  description = "Exact HTTPS API origin; also determines installer resource names."
  type        = string
  validation {
    condition     = can(regex("^https://[a-z0-9]+([.-][a-z0-9]+)+$", var.api_origin))
    error_message = "Use a lowercase HTTPS DNS origin without port, path or trailing slash."
  }
}

variable "register_neon_ca" {
  description = "Register this installation's OS-trusted public ISRG Root X1 CA for verified Neon TLS. Existing external CA IDs are not owned here."
  type        = bool
  default     = false
}

variable "database_ca_pem" {
  description = "Public CA obtained by the maintained runner from its OS trust store. Never a private key or a certificate learned from an unauthenticated peer."
  type        = string
  default     = ""
  validation {
    condition     = !var.register_neon_ca || (startswith(trimspace(var.database_ca_pem), "-----BEGIN CERTIFICATE-----") && !strcontains(var.database_ca_pem, "PRIVATE KEY"))
    error_message = "Automatic registration requires the public CA supplied by the maintained customer runner."
  }
}

variable "r2_buckets" {
  description = "Create this installation's files and Agent Connect release R2 buckets. False when the operator brings an S3-compatible bucket instead."
  type        = bool
  default     = true
}
