mock_provider "google" {}
mock_provider "kubernetes" {}

variables {
  project_id        = "customer-project"
  project_number    = "123456789012"
  database_instance = "azad-board-1a2b-db"
  namespace         = "azad"
  image             = "ghcr.io/kodu-ai/azad-updater@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  install_bucket    = "azad-board-1a2b-1f2e3d4c-install"
}

run "the_updater_reaches_only_the_apps_install_state" {
  command = plan
  assert {
    condition     = google_storage_bucket_iam_member.install.condition[0].expression == "resource.name.startsWith(\"projects/_/buckets/azad-board-1a2b-1f2e3d4c-install/objects/install/\")" && google_storage_bucket_iam_member.install.role == "roles/storage.objectUser"
    error_message = "The updater writes install/ objects only; Terraform's state under terraform/ stays out of reach."
  }
  assert {
    condition     = google_storage_bucket_iam_member.status.condition[0].expression == google_storage_bucket_iam_member.install.condition[0].expression && google_storage_bucket_iam_member.status.role == "roles/storage.objectViewer" && endswith(google_storage_bucket_iam_member.status.member, "/subject/ns/azad/sa/azad-api")
    error_message = "The API pods' starter only reads the same install/ objects."
  }
  assert {
    condition     = endswith(google_storage_bucket_iam_member.install.member, "/subject/ns/azad/sa/azad-updater") && startswith(google_storage_bucket_iam_member.install.member, "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/customer-project.svc.id.goog/")
    error_message = "The grant goes to the updater's own Workload Identity principal."
  }
}

run "the_updater_reads_only_this_installations_secrets" {
  command = plan
  assert {
    condition     = toset(keys(google_project_iam_member.secrets)) == toset(["roles/secretmanager.viewer", "roles/secretmanager.secretAccessor"])
    error_message = "The updater lists and reads secret versions and never writes them."
  }
  assert {
    condition     = alltrue([for grant in google_project_iam_member.secrets : grant.condition[0].expression == "resource.name.startsWith(\"projects/123456789012/secrets/azad-board-1a2b-1f2e3d4c-install-\")"])
    error_message = "Secret access is limited to the store's <bucket>-<name> secrets."
  }
}

run "the_updater_backs_up_only_this_installations_database" {
  command = plan
  assert {
    condition     = google_project_iam_member.restore_point.role == "roles/cloudsql.editor" && google_project_iam_member.restore_point.condition[0].expression == "resource.name == \"projects/customer-project/instances/azad-board-1a2b-db\""
    error_message = "The restore point's backup reaches only the installation's instance."
  }
  assert {
    condition     = google_project_iam_member.database_client.role == "roles/cloudsql.client"
    error_message = "Migrations connect through the Cloud SQL Auth Proxy."
  }
}

run "the_starter_alone_holds_the_api_token_and_creates_jobs" {
  command = plan
  assert {
    condition     = !kubernetes_service_account_v1.updater.automount_service_account_token
    error_message = "Update Jobs run without a Kubernetes token."
  }
  assert {
    condition     = output.starter.kubernetes_api_token && jsonencode(output.starter.args) == jsonencode(["update-host", "gke"]) && output.starter.env.AZAD_UPDATER_LISTEN == "127.0.0.1:8095" && output.url == "http://127.0.0.1:8095"
    error_message = "The starter listens on the pod's loopback, where the API reaches it."
  }
  assert {
    condition     = jsondecode(output.starter.env.AZAD_INSTALL_STORE) == { kind = "gcs", bucket = "azad-board-1a2b-1f2e3d4c-install", project_id = "customer-project" }
    error_message = "The starter reads the installation's store."
  }
  assert {
    condition     = kubernetes_role_binding_v1.starter.subject[0].name == "azad-api" && length(kubernetes_role_v1.starter.rule) == 2 && toset(kubernetes_role_v1.starter.rule[0].verbs) == toset(["create", "get", "list", "watch"])
    error_message = "The API pods' service account may create and read update Jobs, and read pods, in the namespace."
  }
}

run "the_image_is_pinned_by_digest" {
  command = plan
  variables {
    image = "ghcr.io/kodu-ai/azad-updater:latest"
  }
  expect_failures = [var.image]
}
