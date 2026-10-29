# cert-manager from Jetstack's official chart, the prerequisite of operators
# that serve admission webhooks (it issues and injects their certificates).
# Leader election stays in cert-manager's own namespace because GKE Autopilot
# does not allow writes to kube-system. CRDs are installed and, on destroy,
# removed with the release, after every Certificate and Issuer is gone.
# Owned here rather than by Helm, which never deletes a namespace it created.
resource "kubernetes_namespace_v1" "cert_manager" {
  metadata {
    name = var.namespace
  }
}

resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  namespace  = kubernetes_namespace_v1.cert_manager.metadata[0].name
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  version    = var.chart_version
  wait       = true
  # A failed install or upgrade is removed or rolled back, so a rerun can
  # apply cleanly instead of finding a half-installed release it does not own.
  atomic  = true
  timeout = 600
  values = [yamlencode({
    crds   = { enabled = true, keep = false }
    global = { leaderElection = { namespace = var.namespace } }
    resources = {
      requests = { cpu = "50m", memory = "128Mi" }
    }
    webhook = {
      resources = { requests = { cpu = "50m", memory = "64Mi" } }
    }
    cainjector = {
      resources = { requests = { cpu = "50m", memory = "128Mi" } }
    }
    startupapicheck = {
      resources = { requests = { cpu = "50m", memory = "64Mi" } }
    }
  })]
}
