# Google's Cloud SQL Proxy Operator: an AuthProxyWorkload resource injects the
# Cloud SQL Auth Proxy into the pods of the workload it selects, with the
# pod's own Workload Identity. Installed from the official release manifest
# (the operator's documented `kubectl apply`), pinned by version and digest.
# Its webhooks take their certificate from cert-manager, so the caller orders
# this module after cert-manager (depends_on).

locals {
  manifest_url = "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy-operator/${var.release.version}/cloud-sql-proxy-operator.yaml"
  namespace    = "cloud-sql-proxy-operator-system"
  # The namespace is a resource of this module (Helm never deletes one it
  # creates), so the manifest's Namespace document is left out.
  objects = [
    for document in split("\n---\n", data.http.manifest.response_body) : yamldecode(document)
    if trimspace(document) != "" && try(yamldecode(document).kind, "") != "Namespace"
  ]
}

data "http" "manifest" {
  url = local.manifest_url
  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && sha256(self.response_body) == var.release.sha256
      error_message = "The Cloud SQL Proxy Operator manifest does not match its pinned SHA-256."
    }
  }
}

resource "kubernetes_namespace_v1" "operator" {
  metadata {
    name   = local.namespace
    labels = { "control-plane" = "controller-manager" }
  }
}

module "operator" {
  source    = "../../kubernetes/manifests"
  name      = "cloud-sql-proxy-operator"
  namespace = kubernetes_namespace_v1.operator.metadata[0].name
  manifests = local.objects
}
