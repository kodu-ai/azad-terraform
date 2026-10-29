# Scheduled disk snapshots of one namespace with Google's managed Backup for
# GKE: volume data (Forgejo's repositories, celld's state) and the namespace's
# Kubernetes objects, kept for a retention period. Restores go through Backup
# for GKE restore plans.
resource "google_project_service" "gkebackup" {
  project            = var.project_id
  service            = "gkebackup.googleapis.com"
  disable_on_destroy = false
}

resource "google_gke_backup_backup_plan" "this" {
  project  = var.project_id
  name     = var.name
  location = var.location
  cluster  = var.cluster_id

  retention_policy {
    backup_retain_days = var.retain_days
  }
  backup_schedule {
    cron_schedule = var.cron_schedule
  }
  backup_config {
    include_volume_data = true
    include_secrets     = true
    selected_namespaces {
      namespaces = [var.namespace]
    }
  }

  depends_on = [google_project_service.gkebackup]
}

# A backup plan can only be deleted without backups. When the installation is
# disposable, destroy deletes the plan's backups first (REST API with the
# deploying machine's gcloud credentials) and waits until none remain.
resource "terraform_data" "delete_backups" {
  count = var.delete_backups_on_destroy ? 1 : 0
  input = { plan = google_gke_backup_backup_plan.this.id }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/bash", "-c"]
    environment = { PLAN = self.input.plan }
    command     = <<-EOT
      set -euo pipefail
      command -v gcloud >/dev/null || { echo "gcloud is required to delete the plan's backups." >&2; exit 1; }
      api="https://gkebackup.googleapis.com/v1/$PLAN/backups"
      for attempt in $(seq 1 60); do
        # The access token reaches curl on stdin (-H @-), never its command line.
        auth="Authorization: Bearer $(gcloud auth print-access-token)"
        names=$(printf '%s\n' "$auth" | curl -fsS -H @- "$api?pageSize=500" | python3 -c 'import json,sys; [print(b["name"]) for b in json.load(sys.stdin).get("backups", [])]')
        [ -z "$names" ] && exit 0
        for name in $names; do
          printf '%s\n' "$auth" | curl -fsS -X DELETE -H @- "https://gkebackup.googleapis.com/v1/$name?force=true" >/dev/null || true
        done
        echo "Waiting for $(echo "$names" | wc -l | tr -d ' ') backup(s) to be deleted"
        sleep 10
      done
      echo "Backups of $PLAN still exist after 10 minutes." >&2
      exit 1
    EOT
  }
}
