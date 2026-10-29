locals {
  labels = {
    "app.kubernetes.io/name"       = var.name
    "app.kubernetes.io/part-of"    = "azad"
    "app.kubernetes.io/managed-by" = "terraform"
  }
  peers = "${var.name}-peers"
  # The stop grace stays above celld's handoff bound (CELLD_SHUTDOWN_TOTAL_MS)
  # so SIGKILL never interrupts the transfer of cells to a surviving node.
  # Spot capacity allows at most 25 s, so the handoff budget shrinks with it.
  shutdown_total_ms         = var.spot ? 20000 : 40000
  termination_grace_seconds = var.spot ? 25 : 60
  node_selector             = merge(var.node_selector, var.spot ? { "cloud.google.com/gke-spot" = "true" } : {})
  tolerations = concat(
    var.tolerations,
    var.spot ? [{ key = "cloud.google.com/gke-spot", value = "true", operator = "Equal", effect = "NoSchedule" }] : [],
  )

  pooler = var.database_pooler == null ? [] : [var.database_pooler]
  pooler_config = var.database_pooler == null ? null : templatefile("${path.module}/pgbouncer.ini.tftpl", {
    fleet                  = var.name
    database               = var.database_pooler.database
    server_host            = var.database_pooler.server.host
    server_port            = var.database_pooler.server.port
    port                   = var.database_pooler.port
    pool_size              = var.database_pooler.pool_size
    min_pool_size          = var.database_pooler.min_pool_size
    max_client_connections = var.database_pooler.max_client_connections
  })
  # PgBouncer's auth file format: quoted name and password, quotes doubled.
  pooler_users = var.database_pooler == null ? null : format(
    "\"%s\" \"%s\"\n",
    var.database_pooler.username,
    replace(var.database_pooler_password, "\"", "\"\""),
  )
  # Kubernetes does not restart pods for a changed ConfigMap or Secret, and the
  # template's annotations belong to GKE (ignore_changes below), so a digest
  # in the pooler's environment rolls the fleet instead. Only a digest: the
  # password stays out of the plan.
  pooler_digest = var.database_pooler == null ? null : nonsensitive(sha256("${local.pooler_config}\n${local.pooler_users}"))
  # A plain TCP connect: PgBouncer listens on loopback only, which kubelet's
  # tcp_socket probe (it dials the pod IP) cannot reach.
  pooler_probe = var.database_pooler == null ? null : ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${var.database_pooler.port}"]
}

# The pooler's settings, and its auth file with the database password.
resource "kubernetes_config_map_v1" "pooler" {
  count = var.database_pooler == null ? 0 : 1
  metadata {
    name      = "${var.name}-pgbouncer"
    namespace = var.namespace
    labels    = local.labels
  }
  data = {
    "pgbouncer.ini" = local.pooler_config
  }
}

resource "kubernetes_secret_v1" "pooler" {
  count = var.database_pooler == null ? 0 : 1
  metadata {
    name      = "${var.name}-pgbouncer"
    namespace = var.namespace
    labels    = local.labels
  }
  data = {
    "userlist.txt" = local.pooler_users
  }
}

resource "kubernetes_service_account_v1" "node" {
  metadata {
    name        = var.name
    namespace   = var.namespace
    labels      = local.labels
    annotations = var.storage.service_account_annotations
  }
}

# Peer traffic is plaintext and the internal listener carries an
# unauthenticated operator API, so it stays on a headless in-cluster service.
resource "kubernetes_service_v1" "peers" {
  metadata {
    name      = local.peers
    namespace = var.namespace
    labels    = local.labels
  }
  lifecycle {
    # GKE adds container-native load balancing annotations to every Service.
    ignore_changes = [metadata[0].annotations]
  }
  spec {
    cluster_ip                  = "None"
    publish_not_ready_addresses = true
    selector                    = local.labels
    port {
      name        = "peer"
      port        = 8081
      target_port = 8081
    }
  }
}

resource "kubernetes_service_v1" "public" {
  metadata {
    name        = var.name
    namespace   = var.namespace
    labels      = local.labels
    annotations = var.service.annotations
  }
  lifecycle {
    # Written by the GKE NEG controller.
    ignore_changes = [metadata[0].annotations["cloud.google.com/neg-status"]]
  }
  spec {
    type     = var.service.type
    selector = local.labels
    port {
      name        = "http"
      port        = var.service.port
      target_port = 8080
    }
  }
}

resource "kubernetes_stateful_set_v1" "fleet" {
  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }
  spec {
    service_name          = local.peers
    replicas              = var.replicas
    pod_management_policy = "Parallel"
    selector {
      match_labels = local.labels
    }
    template {
      metadata {
        labels = local.labels
      }
      spec {
        service_account_name             = kubernetes_service_account_v1.node.metadata[0].name
        termination_grace_period_seconds = local.termination_grace_seconds
        node_selector                    = local.node_selector
        dynamic "toleration" {
          for_each = local.tolerations
          content {
            key      = toleration.value.key
            operator = toleration.value.operator
            value    = toleration.value.value
            effect   = toleration.value.effect
          }
        }
        security_context {
          run_as_non_root = true
          run_as_user     = 65532
          fs_group        = 65532
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        # A native sidecar (an init container that keeps running): it is
        # listening before celld starts and is stopped only after celld exits.
        dynamic "init_container" {
          for_each = local.pooler
          content {
            name           = "pgbouncer"
            image          = init_container.value.image
            restart_policy = "Always"
            args           = ["/etc/pgbouncer/pgbouncer.ini"]
            env {
              name  = "PGBOUNCER_CONFIG_SHA256"
              value = local.pooler_digest
            }
            startup_probe {
              exec {
                command = local.pooler_probe
              }
              period_seconds    = 1
              failure_threshold = 30
            }
            readiness_probe {
              exec {
                command = local.pooler_probe
              }
              period_seconds = 10
            }
            liveness_probe {
              exec {
                command = local.pooler_probe
              }
              period_seconds    = 20
              failure_threshold = 3
            }
            resources {
              requests = {
                cpu                 = init_container.value.cpu_request
                memory              = init_container.value.memory_request
                "ephemeral-storage" = "64Mi"
              }
              limits = {
                memory              = init_container.value.memory_request
                "ephemeral-storage" = "64Mi"
              }
            }
            security_context {
              run_as_non_root            = true
              allow_privilege_escalation = false
              read_only_root_filesystem  = true
              capabilities {
                drop = ["ALL"]
              }
            }
            volume_mount {
              name       = "pgbouncer-config"
              mount_path = "/etc/pgbouncer"
              read_only  = true
            }
            volume_mount {
              name       = "pgbouncer-auth"
              mount_path = "/etc/pgbouncer-auth"
              read_only  = true
            }
          }
        }
        container {
          name  = "celld"
          image = var.image
          args = concat(
            [
              "--bucket", var.bucket,
              "--listen", "0.0.0.0:8080",
              "--internal-listen", "0.0.0.0:8081",
              # Stable per-pod DNS through the headless service; peers route to the internal listener.
              "--advertise", "$(POD_NAME).${local.peers}.${var.namespace}.svc.cluster.local:8081",
            ],
            var.storage.endpoint == null ? [] : ["--endpoint", var.storage.endpoint],
            var.storage.region == null ? [] : ["--region", var.storage.region],
            var.trust_forwarded_headers ? ["--trust-forwarded-headers"] : [],
          )
          env {
            name = "POD_NAME"
            value_from {
              field_ref {
                field_path = "metadata.name"
              }
            }
          }
          env {
            name  = "HOME"
            value = "/var/lib/celld"
          }
          env {
            name  = "CELLD_WATCH"
            value = "/var/lib/celld/state"
          }
          env {
            name  = "CELLD_V8_HEAP_LIMIT_MB"
            value = tostring(var.v8_heap_limit_mb)
          }
          env {
            name  = "CELLD_SHUTDOWN_TOTAL_MS"
            value = tostring(local.shutdown_total_ms)
          }
          dynamic "env" {
            for_each = var.storage.env
            content {
              name  = env.key
              value = env.value
            }
          }
          dynamic "env_from" {
            for_each = var.storage.credentials_secret == null ? [] : [var.storage.credentials_secret]
            content {
              secret_ref {
                name = env_from.value
              }
            }
          }
          port {
            name           = "http"
            container_port = 8080
          }
          port {
            name           = "peer"
            container_port = 8081
          }
          readiness_probe {
            http_get {
              path = "/.well-known/celld/health"
              port = "http"
            }
            period_seconds    = 5
            failure_threshold = 2
          }
          liveness_probe {
            tcp_socket {
              port = "peer"
            }
            initial_delay_seconds = 30
            period_seconds        = 20
          }
          resources {
            requests = {
              cpu                 = var.resources.cpu_request
              memory              = var.resources.memory_request
              "ephemeral-storage" = "1Gi"
            }
            limits = {
              memory              = var.resources.memory_limit
              "ephemeral-storage" = "1Gi"
            }
          }
          security_context {
            allow_privilege_escalation = false
            capabilities {
              drop = ["NET_RAW"]
            }
          }
          volume_mount {
            name       = "state"
            mount_path = "/var/lib/celld"
          }
        }
        dynamic "container" {
          for_each = var.sidecars
          content {
            name  = container.value.name
            image = container.value.image
            args  = container.value.args
            resources {
              requests = {
                cpu                 = container.value.cpu_request
                memory              = container.value.memory_request
                "ephemeral-storage" = "1Gi"
              }
              limits = {
                "ephemeral-storage" = "1Gi"
              }
            }
            security_context {
              run_as_non_root            = true
              allow_privilege_escalation = false
              capabilities {
                drop = ["NET_RAW"]
              }
            }
          }
        }
        dynamic "volume" {
          for_each = kubernetes_config_map_v1.pooler
          content {
            name = "pgbouncer-config"
            config_map {
              name = volume.value.metadata[0].name
            }
          }
        }
        dynamic "volume" {
          for_each = kubernetes_secret_v1.pooler
          content {
            name = "pgbouncer-auth"
            secret {
              secret_name = volume.value.metadata[0].name
              # Readable by the pod's fs_group, which PgBouncer runs in.
              default_mode = "0440"
            }
          }
        }
      }
    }
    volume_claim_template {
      metadata {
        name = "state"
      }
      spec {
        access_modes       = ["ReadWriteOnce"]
        storage_class_name = var.state_volume.storage_class
        resources {
          requests = {
            storage = var.state_volume.size
          }
        }
      }
    }
  }
  wait_for_rollout = false

  lifecycle {
    # GKE Autopilot records its admission decisions as annotations.
    ignore_changes = [
      metadata[0].annotations,
      spec[0].template[0].metadata[0].annotations,
    ]
  }
}

resource "kubernetes_pod_disruption_budget_v1" "fleet" {
  count = var.replicas > 1 ? 1 : 0
  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }
  spec {
    max_unavailable = 1
    selector {
      match_labels = local.labels
    }
  }
}
