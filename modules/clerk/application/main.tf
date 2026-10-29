# The Clerk application the setup created. It is not a Terraform-managed
# resource (there is no official Clerk provider); this only deletes it on
# destroy, through Clerk's Platform API with the setup's Clerk CLI login, when
# the installation is disposable. Deleting it removes every user account.
resource "terraform_data" "application" {
  count = var.application.delete_on_destroy ? 1 : 0
  input = { id = var.application.id }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/sh", "-c"]
    environment = {
      APP_ID                   = self.input.id
      CLERK_TELEMETRY_DISABLED = "1"
      DO_NOT_TRACK             = "1"
    }
    command = <<-EOT
      case "$APP_ID" in app_*) ;; *) echo "Invalid Clerk application id." >&2; exit 1;; esac
      if out=$(npx --yes clerk@4.0.0 api --platform --mode agent --yes -X DELETE "/v1/platform/applications/$APP_ID" </dev/null 2>&1); then
        echo "Deleted Clerk application $APP_ID."
        exit 0
      fi
      case "$out" in *resource_not_found*|*"not found"*) echo "Clerk application $APP_ID is already gone."; exit 0;; esac
      echo "Clerk did not delete application $APP_ID. Sign in with 'npx clerk@4.0.0 auth login', then rerun destroy." >&2
      exit 1
    EOT
  }
}
