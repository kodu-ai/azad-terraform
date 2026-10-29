variable "namespace" {
  description = "Namespace of the release; destroy removes its volume claim with it."
  type        = string
}

variable "name" {
  description = "Release name. The HTTP Service is <name>-http, so keep it containing \"forgejo\"."
  type        = string
  default     = "forgejo"
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$", var.name)) && strcontains(var.name, "forgejo")
    error_message = "Use a short lowercase DNS label containing \"forgejo\"."
  }
}

variable "chart_version" {
  description = "Exact forgejo-helm chart version (oci://code.forgejo.org/forgejo-helm/forgejo). 17.3.2 ships Forgejo 15.0.11."
  type        = string
  default     = "17.3.2"
}

variable "username" {
  description = "Service account the Azad API uses with HTTP Basic auth for the REST API and Git; a Forgejo administrator so it can create organizations and repositories."
  type        = string
  default     = "azad"
}

variable "storage" {
  description = "Repository and SQLite volume. A null class uses the cluster default."
  type = object({
    size  = optional(string, "10Gi")
    class = optional(string)
  })
  default = {}
}

variable "resources" {
  description = "Container requests and memory limit."
  type = object({
    cpu_request    = optional(string, "250m")
    memory_request = optional(string, "512Mi")
    memory_limit   = optional(string, "1Gi")
  })
  default = {}
}

variable "spot" {
  description = "Schedule on Spot capacity (GKE). Forgejo restarts on another node with the same volume."
  type        = bool
  default     = false
}

variable "tolerations" {
  description = "Pod tolerations, for example the architecture taint a managed cluster applies. Spot adds its own."
  type = list(object({
    key      = string
    value    = string
    operator = optional(string, "Equal")
    effect   = optional(string, "NoSchedule")
  }))
  default = []
}

variable "node_selector" {
  description = "Extra node selector labels."
  type        = map(string)
  default     = {}
}
