output "database" {
  description = "Cloud SQL identity and public endpoint, without credentials."
  value       = module.postgres.connection
}

output "bucket" {
  description = "Customer-owned GCS bucket that Azad stores files and Agent Connect releases in."
  value       = google_storage_bucket.files.name
}

output "env_file" {
  description = "Private dotenv holding DATABASE_URL and STORAGE_* for the installer credentials."
  value       = local_sensitive_file.customer_env.filename
}
