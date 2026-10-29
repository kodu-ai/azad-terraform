# Forgejo as the installation's managed Git host: one private, cluster-internal
# instance holding each project's control repository. Azad's API is its only
# client — it creates the organization and repositories over the REST API and
# proxies every Git fetch and push through its own gateway — so nothing here is
# exposed outside the cluster: no Ingress, no SSH, no registration.

locals {
  host = "${var.name}-http.${var.namespace}.svc.cluster.local"
  url  = "http://${local.host}:3000"
  node_selector = merge(
    var.node_selector,
    var.spot ? { "cloud.google.com/gke-spot" = "true" } : {},
  )
  tolerations = concat(
    var.tolerations,
    var.spot ? [{ key = "cloud.google.com/gke-spot", value = "true", operator = "Equal", effect = "NoSchedule" }] : [],
  )
}

resource "random_password" "service" {
  length  = 32
  special = false
}

# The chart reads the service account from this Secret (keys username and
# password), so the password never appears in Helm values or release history.
resource "kubernetes_secret_v1" "service" {
  metadata {
    name      = "${var.name}-service-account"
    namespace = var.namespace
  }
  data = {
    username = var.username
    password = random_password.service.result
  }
}

resource "helm_release" "forgejo" {
  name       = var.name
  namespace  = var.namespace
  repository = "oci://code.forgejo.org/forgejo-helm"
  chart      = "forgejo"
  version    = var.chart_version
  wait       = true
  # A failed install or upgrade is removed or rolled back, so a rerun can
  # apply cleanly instead of finding a half-installed release it does not own.
  atomic  = true
  timeout = 900

  values = [yamlencode({
    strategy = { type = "Recreate" }
    image    = { rootless = true }
    test     = { enabled = false }
    podSecurityContext = {
      fsGroup        = 1000
      seccompProfile = { type = "RuntimeDefault" }
    }
    containerSecurityContext = {
      allowPrivilegeEscalation = false
      capabilities             = { drop = ["ALL"] }
      privileged               = false
      runAsNonRoot             = true
      runAsUser                = 1000
      runAsGroup               = 1000
    }
    resources = {
      requests = {
        cpu                 = var.resources.cpu_request
        memory              = var.resources.memory_request
        "ephemeral-storage" = "1Gi"
      }
      limits = { memory = var.resources.memory_limit }
    }
    initContainers = {
      resources = {
        requests = { cpu = "100m", memory = "128Mi", "ephemeral-storage" = "1Gi" }
        limits   = { memory = "256Mi" }
      }
    }
    nodeSelector = local.node_selector
    tolerations  = local.tolerations
    service = {
      http = { type = "ClusterIP", port = 3000 }
      ssh  = { type = "ClusterIP", port = 22 }
    }
    persistence = merge(
      { enabled = true, create = true, size = var.storage.size },
      var.storage.class == null ? {} : { storageClass = var.storage.class },
      # The chart keeps its claim after uninstall by default; destroy must
      # remove the disk with the release.
      { annotations = {} },
    )
    gitea = {
      admin = {
        existingSecret = kubernetes_secret_v1.service.metadata[0].name
        email          = "${var.username}@${local.host}"
        passwordMode   = "keepUpdated"
      }
      config = {
        APP_NAME = "Azad managed Git"
        server = {
          DOMAIN           = local.host
          ROOT_URL         = "${local.url}/"
          HTTP_PORT        = 3000
          DISABLE_SSH      = true
          START_SSH_SERVER = false
          SSH_PORT         = 22
          SSH_LISTEN_PORT  = 2222
          OFFLINE_MODE     = true
          LFS_START_SERVER = false
        }
        service = {
          DISABLE_REGISTRATION              = true
          REQUIRE_SIGNIN_VIEW               = true
          ENABLE_BASIC_AUTHENTICATION       = true
          DEFAULT_ALLOW_CREATE_ORGANIZATION = true
        }
        repository = {
          DEFAULT_BRANCH          = "main"
          DEFAULT_PRIVATE         = "private"
          DISABLE_STARS           = true
          ENABLE_PUSH_CREATE_USER = false
          ENABLE_PUSH_CREATE_ORG  = false
        }
        security              = { INSTALL_LOCK = true }
        actions               = { ENABLED = false }
        packages              = { ENABLED = false }
        api                   = { ENABLE_SWAGGER = false }
        mailer                = { ENABLED = false }
        "cron.update_checker" = { ENABLED = false }
        log                   = { LEVEL = "Warn" }
      }
    }
  })]
}
