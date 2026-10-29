mock_provider "helm" {}
mock_provider "kubernetes" {}

mock_provider "http" {
  mock_data "http" {
    defaults = {
      status_code   = 200
      response_body = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: tampered\n"
    }
  }
}

run "a_manifest_that_does_not_match_its_pinned_digest_is_refused" {
  command         = plan
  expect_failures = [data.http.manifest]
}
