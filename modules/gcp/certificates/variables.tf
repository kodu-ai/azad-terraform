variable "project_id" {
  description = "Project that owns the certificate."
  type        = string
}

variable "region" {
  description = "Region of the load balancer that serves the certificate."
  type        = string
}

variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "domains" {
  description = "Domains to authorize. The certificate covers each domain and its first-level wildcard, e.g. board.example.com and *.board.example.com."
  type        = list(string)
}
