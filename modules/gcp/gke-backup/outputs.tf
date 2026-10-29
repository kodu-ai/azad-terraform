output "plan" {
  description = "Backup plan resource name, for restores."
  value       = google_gke_backup_backup_plan.this.id
}
