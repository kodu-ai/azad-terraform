variable "name" {
  description = "Helm release name; it owns exactly the objects in manifests."
  type        = string
}

variable "namespace" {
  description = "Existing namespace of the release record, and of namespaced objects that do not name one. Create it as a Terraform resource: Helm never deletes a namespace it creates."
  type        = string
}

variable "manifests" {
  description = "Kubernetes objects (decoded YAML), applied verbatim. Values are never templated, so object contents cannot inject Helm templates."
  # Objects of different kinds have different shapes, so this is a tuple, not list(any).
  type = any
  validation {
    condition     = can(length(var.manifests)) && alltrue([for object in var.manifests : can(object.kind) && can(object.apiVersion)])
    error_message = "Pass a list of Kubernetes objects, each with apiVersion and kind."
  }
}

variable "timeout_seconds" {
  description = "Install, upgrade and uninstall timeout. Uninstall waits until the objects are gone, so finalizers complete while their controllers still run."
  type        = number
  default     = 600
}
