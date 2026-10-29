# Applies Kubernetes objects whose kinds are defined by CRDs installed in the
# same apply (cert-manager's Certificate, an operator's custom resources).
# kubernetes_manifest needs those CRDs at plan time; a Helm release resolves
# kinds when it applies, orders after its depends_on, and its uninstall waits
# until the objects — including their finalizers — are gone.
resource "helm_release" "this" {
  name      = var.name
  namespace = var.namespace
  chart     = "${path.module}/chart"
  wait      = true
  # A failed install or upgrade is removed or rolled back, so a rerun can
  # apply cleanly instead of finding a half-installed release it does not own.
  atomic  = true
  timeout = var.timeout_seconds
  values  = [yamlencode({ manifests = var.manifests })]
}
