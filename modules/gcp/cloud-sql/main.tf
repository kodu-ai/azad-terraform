resource "google_project_service" "sqladmin" {
  project            = var.settings.project_id
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

resource "google_sql_database_instance" "postgres" {
  project             = var.settings.project_id
  name                = var.settings.instance_name
  region              = var.settings.region
  database_version    = "POSTGRES_17"
  deletion_protection = var.settings.deletion_protection

  settings {
    edition           = "ENTERPRISE"
    tier              = var.settings.tier
    availability_type = var.settings.availability_type
    disk_type         = "PD_SSD"
    disk_size         = var.settings.disk_size_gb
    disk_autoresize   = true
    user_labels       = var.settings.labels

    dynamic "database_flags" {
      for_each = var.settings.database_flags
      content {
        name  = database_flags.key
        value = database_flags.value
      }
    }

    backup_configuration {
      enabled                        = var.settings.backups
      point_in_time_recovery_enabled = var.settings.backups
    }

    # Current self-host installer and Hyperdrive use a public TCP origin.
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
      dynamic "authorized_networks" {
        for_each = var.settings.authorized_networks
        content {
          name  = authorized_networks.key
          value = authorized_networks.value
        }
      }
    }
  }

  depends_on = [google_project_service.sqladmin]
}

resource "google_sql_database" "azad" {
  project  = var.settings.project_id
  instance = google_sql_database_instance.postgres.name
  name     = var.settings.database_name

  deletion_policy = var.settings.deletion_policy

  # Reverse destroy order drops migrated tables before deleting their owning role.
  depends_on = [google_sql_user.azad]
}

# Cloud SQL built-in users have cloudsqlsuperuser privileges, including the
# schema creation needed by the existing migration runner. No SQL bootstrap fork.
resource "google_sql_user" "azad" {
  project  = var.settings.project_id
  instance = google_sql_database_instance.postgres.name
  name     = var.settings.username
  password = var.password

  deletion_policy = var.settings.deletion_policy == "ABANDON" ? "ABANDON" : null
}
