# Release updates on Google Cloud, started from the console: a one-off
# Kubernetes Job runs the updater image as azad-updater, the only identity
# that can deploy. The API never holds that access. A sidecar in each API pod
# (the starter, listening on the pod's loopback) creates the Job and reads its
# status; it alone in the pod holds the API's Kubernetes token
# (modules/celld/fleet, kubernetes_api_token). Terraform creates no Job: each
# update creates its own, and an update never changes this configuration.

locals {
  service_account = "azad-updater"
  pool            = "principal://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/${var.namespace}/sa"
  updater         = "${local.pool}/${local.service_account}"
  api             = "${local.pool}/${var.api_service_account}"
  listen          = "127.0.0.1:8095"
  # The app's objects (deployment, receipt, source manifest, operation) are
  # install/<key>.json; Terraform's state beside them stays out of reach.
  install_objects = "resource.name.startsWith(\"projects/_/buckets/${var.install_bucket}/objects/install/\")"
  # The store's secrets are <bucket>-<name> (secrets, release-key, settings,
  # handoff, relay); Secret Manager names them by project number.
  install_secrets = "resource.name.startsWith(\"projects/${var.project_number}/secrets/${var.install_bucket}-\")"
  database        = "resource.name == \"projects/${var.project_id}/instances/${var.database_instance}\""
}

resource "kubernetes_service_account_v1" "updater" {
  metadata {
    name      = local.service_account
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"       = local.service_account
      "app.kubernetes.io/part-of"    = "azad"
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
  # The updater calls Google's APIs through Workload Identity, never the
  # Kubernetes API.
  automount_service_account_token = false
}

# Reads one secret's enabled versions (Secret Manager Viewer), then the
# version's value (Secret Accessor): the store lists before it accesses. It
# never writes secrets. Predefined roles only, so the documented installer
# permissions (Editor plus Project IAM Admin) can grant them.
resource "google_project_iam_member" "secrets" {
  for_each = toset(["roles/secretmanager.viewer", "roles/secretmanager.secretAccessor"])
  project  = var.project_id
  role     = each.value
  member   = local.updater
  condition {
    title       = "azad-install-secrets"
    description = "Only this installation's secrets."
    expression  = local.install_secrets
  }
}

resource "google_storage_bucket_iam_member" "install" {
  bucket = var.install_bucket
  role   = "roles/storage.objectUser"
  member = local.updater
  condition {
    title       = "azad-install-objects"
    description = "Only the app's install state, never Terraform's."
    expression  = local.install_objects
  }
}

# The starter shows the console the operation record, receipt and deployment.
resource "google_storage_bucket_iam_member" "status" {
  bucket = var.install_bucket
  role   = "roles/storage.objectViewer"
  member = local.api
  condition {
    title       = "azad-install-objects"
    description = "Only the app's install state, never Terraform's."
    expression  = local.install_objects
  }
}

# Migrations reach the database through the Cloud SQL Auth Proxy.
resource "google_project_iam_member" "database_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = local.updater
}

# The restore point: an on-demand backup taken, and read back, before an
# update changes the database (backupRuns insert and get). Cloud SQL Editor
# is the narrowest predefined role with them, limited to this installation's
# instance; it cannot delete the instance or its backups.
resource "google_project_iam_member" "restore_point" {
  project = var.project_id
  role    = "roles/cloudsql.editor"
  member  = local.updater
  condition {
    title       = "azad-install-database"
    description = "Only this installation's Cloud SQL instance."
    expression  = local.database
  }
}

# The starter's Kubernetes access, through the API pods' service account:
# create update Jobs and read them and their pods. Nothing else in the pod
# holds this token.
resource "kubernetes_role_v1" "starter" {
  metadata {
    name      = "azad-update-starter"
    namespace = var.namespace
  }
  rule {
    api_groups = ["batch"]
    resources  = ["jobs"]
    verbs      = ["create", "get", "list", "watch"]
  }
  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["get", "list"]
  }
}

resource "kubernetes_role_binding_v1" "starter" {
  metadata {
    name      = "azad-update-starter"
    namespace = var.namespace
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.starter.metadata[0].name
  }
  subject {
    kind      = "ServiceAccount"
    name      = var.api_service_account
    namespace = var.namespace
  }
}
