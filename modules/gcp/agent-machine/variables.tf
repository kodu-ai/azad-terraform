variable "project_id" {
  description = "Project of the machine."
  type        = string
}

variable "region" {
  description = "Region of the machine (the cluster's region); the first available zone is used."
  type        = string
}

variable "name" {
  description = "Installation name; resources are named <name>-agents."
  type        = string
}

variable "machine_type" {
  description = "Compute Engine machine type, e.g. n2-custom-8-16384 (8 vCPU, 16 GB)."
  type        = string
}

variable "disk_size_gb" {
  description = "Boot disk size; agents keep their workspaces on it."
  type        = number
  default     = 100
}

variable "user" {
  description = "Account the API signs in as. Compute Engine's guest agent creates it with passwordless sudo, so the runtime can install what it needs."
  type        = string
  default     = "azad"
}

variable "network" {
  description = "VPC of the cluster whose pods connect to this machine."
  type        = string
}

variable "subnetwork" {
  description = "Subnetwork of the cluster in this region."
  type        = string
}

variable "ssh_source_ranges" {
  description = "Ranges allowed to reach SSH: the cluster's pod range. The machine has no public address."
  type        = list(string)
}

variable "deletion_protection" {
  description = "Protect the machine (and the workspaces on its disk) from terraform destroy."
  type        = bool
  default     = true
}
