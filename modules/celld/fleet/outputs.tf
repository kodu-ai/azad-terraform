output "service" {
  description = "Public listener Service; route Ingress or the load balancer here."
  value = {
    name      = kubernetes_service_v1.public.metadata[0].name
    namespace = var.namespace
    port      = var.service.port
  }
}

output "bucket" {
  description = "Fleet bucket the installer deploys bundles and R2-binding objects into."
  value       = var.bucket
}

output "database_endpoint" {
  description = "host:port of the pod-local PgBouncer for the Worker's DATABASE_URL (same user, password and database); null without database_pooler."
  value       = var.database_pooler == null ? null : "127.0.0.1:${var.database_pooler.port}"
  # A deploy that switches the Worker to PgBouncer starts only once the pod
  # template that adds it is applied. Pods roll one at a time after that
  # (wait_for_rollout is off), so a node still on the old template has no
  # PgBouncer until its turn.
  depends_on = [kubernetes_stateful_set_v1.fleet]
}
