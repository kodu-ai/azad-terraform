variable "chart_version" {
  description = "Jetstack cert-manager chart version. v1.19.2 is the version the Cloud SQL Proxy Operator v1.8.4 installer pins."
  type        = string
  default     = "v1.19.2"
}

variable "namespace" {
  description = "Namespace for cert-manager; also its leader-election namespace, which GKE Autopilot requires (kube-system is managed)."
  type        = string
  default     = "cert-manager"
}
