output "database_url" {
  description = "Direct TLS DSN for migrations and installer-owned Hyperdrive. Retained in state."
  sensitive   = true
  value       = "postgresql://${replace(urlencode(var.settings.username), "+", "%20")}:${replace(urlencode(var.password), "+", "%20")}@${google_sql_database_instance.postgres.public_ip_address}:5432/${replace(urlencode(google_sql_database.azad.name), "+", "%20")}?sslmode=require"
  depends_on  = [google_sql_user.azad]
}

output "connection" {
  description = "Cloud SQL identity and direct public endpoint."
  value = {
    instance        = google_sql_database_instance.postgres.name
    connection_name = google_sql_database_instance.postgres.connection_name
    host            = google_sql_database_instance.postgres.public_ip_address
    port            = 5432
    database        = google_sql_database.azad.name
    username        = google_sql_user.azad.name
  }
}
