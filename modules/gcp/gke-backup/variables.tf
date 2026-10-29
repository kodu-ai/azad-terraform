variable "project_id" {
  description = "Project of the cluster."
  type        = string
}

variable "location" {
  description = "Region of the backup plan (the cluster's region)."
  type        = string
}

variable "cluster_id" {
  description = "Cluster to back up (projects/<p>/locations/<l>/clusters/<c>); its Backup for GKE agent must be enabled."
  type        = string
}

variable "name" {
  description = "Backup plan name."
  type        = string
}

variable "namespace" {
  description = "Namespace whose volumes and objects are backed up."
  type        = string
}

variable "cron_schedule" {
  description = "When backups run, as a cron expression in UTC."
  type        = string
}

variable "retain_days" {
  description = "How long each backup is kept."
  type        = number
}

variable "delete_backups_on_destroy" {
  description = "Delete the plan's backups on destroy so the plan can be removed; only for disposable installations."
  type        = bool
  default     = false
}
