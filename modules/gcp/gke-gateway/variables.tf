variable "namespace" {
  description = "Namespace of the celld fleet Services."
  type        = string
}

variable "name" {
  description = "Name prefix of the Gateway and its objects; the Gateway is <name>-regional and its routes <name>-regional-<service>."
  type        = string
  default     = "azad"
}

variable "static_ip_name" {
  description = "Name of the reserved regional external address in the cluster's region (gcp/gke-celld output)."
  type        = string
}

variable "tls" {
  description = "Origin certificate chain and key presented to a proxying CDN (for example a Cloudflare Origin CA certificate). Mutually exclusive with certificates."
  sensitive   = true
  default     = null
  type = object({
    certificate = string
    private_key = string
  })
}

variable "certificates" {
  description = "Regional Certificate Manager certificate names (gcp/certificates output) in the cluster's region. Without them or tls, the load balancer serves plain HTTP only (evaluation before DNS is connected)."
  type        = list(string)
  default     = []
}

variable "routes" {
  description = "Host to backend Service and port. Hosts may be wildcards such as *.apps.board.example.com; each Service is listed with one port."
  type = list(object({
    host    = string
    service = string
    port    = number
  }))
}

variable "backend_timeout_seconds" {
  description = "Load balancer backend timeout. Realtime WebSockets stay open for at most this long, then clients reconnect."
  type        = number
  default     = 3600
}
