variable "name" {
  description = "Fleet name: one celld application (for example azad-api or azad-web). Also the Kubernetes object name prefix."
  type        = string
  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,40}[a-z0-9])?$", var.name))
    error_message = "Use a lowercase DNS label of at most 42 characters."
  }
}

variable "namespace" {
  description = "Existing Kubernetes namespace."
  type        = string
}

variable "image" {
  description = "celld container image. Pin an exact release: mixed celld versions cannot share a fleet."
  type        = string
  default     = "ghcr.io/denoland/celld:v0.6.3"
}

variable "replicas" {
  description = "Nodes in the fleet. Two or more replicate each write to a peer disk, which is far faster than a bucket round trip."
  type        = number
  default     = 2
  validation {
    condition     = var.replicas >= 1 && floor(var.replicas) == var.replicas
    error_message = "Use a whole number of nodes."
  }
}

variable "bucket" {
  description = "Fleet bucket with an optional key prefix: s3://NAME[/PREFIX], gs://NAME[/PREFIX] or az://NAME[/PREFIX]. It holds deployments, cell state and the R2-binding objects."
  type        = string
  validation {
    condition     = can(regex("^(s3|gs|az)://[a-z0-9][a-z0-9._-]{1,62}(/[A-Za-z0-9._/-]+)?$", var.bucket))
    error_message = "Use s3://, gs:// or az:// followed by a bucket name and optional prefix."
  }
}

variable "storage" {
  description = <<-EOT
    How nodes reach the fleet bucket. S3-compatible stores take an endpoint and
    region; credentials come either from an existing Secret (keys such as
    AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or AZURE_* values) or from the
    cloud's workload identity through service account annotations.
  EOT
  type = object({
    endpoint                    = optional(string)
    region                      = optional(string)
    credentials_secret          = optional(string)
    service_account_annotations = optional(map(string), {})
    env                         = optional(map(string), {})
  })
  default = {}
}

variable "resources" {
  description = "Per-node container resources."
  type = object({
    cpu_request    = optional(string, "500m")
    memory_request = optional(string, "1Gi")
    memory_limit   = optional(string, "2Gi")
  })
  default = {}
}

variable "state_volume" {
  description = "Per-node disk for the replicated write log and cell cache. Losing it is safe: the bucket holds the durable state."
  type = object({
    size          = optional(string, "10Gi")
    storage_class = optional(string)
  })
  default = {}
}

variable "service" {
  description = "Public listener Service. Ingress or a cloud load balancer points here; celld does not terminate TLS."
  type = object({
    type        = optional(string, "ClusterIP")
    port        = optional(number, 80)
    annotations = optional(map(string), {})
  })
  default = {}
  validation {
    condition     = contains(["ClusterIP", "NodePort", "LoadBalancer"], var.service.type)
    error_message = "Use ClusterIP, NodePort or LoadBalancer."
  }
}

variable "node_selector" {
  description = "Optional node selector, for example an architecture or node pool."
  type        = map(string)
  default     = {}
}

variable "trust_forwarded_headers" {
  description = "Let the ingress's X-Forwarded-Host and X-Forwarded-Proto set request.url. Enable only behind a proxy that replaces both headers."
  type        = bool
  default     = true
}

variable "v8_heap_limit_mb" {
  description = "Per-isolate V8 heap limit (CELLD_V8_HEAP_LIMIT_MB). An isolate above 90% of it refuses new WebSockets, and every Durable Object loads the whole Worker bundle, so keep headroom above the bundle's working set."
  type        = number
  default     = 256
}

variable "sidecars" {
  description = "Extra containers in each node's pod, for example the Cloud SQL Auth Proxy that gives the Worker a local PostgreSQL endpoint."
  type = list(object({
    name           = string
    image          = string
    args           = optional(list(string), [])
    cpu_request    = optional(string, "100m")
    memory_request = optional(string, "128Mi")
  }))
  default = []
}

variable "database_pooler" {
  description = <<-EOT
    PgBouncer in each node's pod, in transaction mode, between the Worker and a
    PostgreSQL endpoint the pod already reaches (server; for example the Cloud
    SQL Auth Proxy sidecar on 127.0.0.1:5432). The Worker's DATABASE_URL then
    names the database_endpoint output with the same user and password. Each
    node keeps up to pool_size server connections (min_pool_size stay warm), so
    keep pool_size times replicas below the server's max_connections, with room
    for migrations, which connect without PgBouncer. An advisory-lock owner
    (withDatabaseAdvisoryLocks) holds a server connection while it holds or
    waits for its lock and its work needs a second one, so pool_size or more
    waiters on one key in one node stall until a statement times out, as they
    would behind Hyperdrive's pool. Runs as a native sidecar: it starts before
    celld and stops after it, so celld's shutdown handoff keeps database
    access. Null leaves the Worker on the server endpoint directly.
  EOT
  type = object({
    database = string
    username = string
    server = optional(object({
      host = optional(string, "127.0.0.1")
      port = optional(number, 5432)
    }), {})
    port                   = optional(number, 6432)
    pool_size              = optional(number, 20)
    min_pool_size          = optional(number, 2)
    max_client_connections = optional(number, 1000)
    # CloudNativePG's PgBouncer image (CNCF project; the PGDG package on Debian
    # slim, rebuilt for security updates, signed). Pinned by digest. Another
    # image must take the config path as its argument and ship bash (probes).
    image          = optional(string, "ghcr.io/cloudnative-pg/pgbouncer:1.26.1-202610281103-trixie@sha256:2d1edb00dba4ec77f1b2e2aaf06dff994f232b603d03571d49d45cdcc22d019a")
    cpu_request    = optional(string, "100m")
    memory_request = optional(string, "64Mi")
  })
  default = null
  validation {
    condition = var.database_pooler == null ? true : (
      can(regex("^[A-Za-z_][A-Za-z0-9_-]*$", var.database_pooler.database)) &&
      can(regex("^[A-Za-z_][A-Za-z0-9_.@-]*$", var.database_pooler.username)) &&
      var.database_pooler.pool_size >= 1 &&
      var.database_pooler.min_pool_size >= 0 &&
      var.database_pooler.min_pool_size <= var.database_pooler.pool_size &&
      var.database_pooler.max_client_connections >= var.database_pooler.pool_size
    )
    error_message = "Use a plain database and user name, a pool_size of at least 1, min_pool_size within it and max_client_connections at least pool_size."
  }
}

variable "database_pooler_password" {
  description = "Password of database_pooler.username; required with database_pooler. Kept only in the pooler's Kubernetes Secret."
  type        = string
  sensitive   = true
  default     = null
  validation {
    condition     = var.database_pooler == null ? true : try(length(var.database_pooler_password) > 0, false)
    error_message = "database_pooler needs the database user's password."
  }
}

variable "spot" {
  description = "Schedule nodes on Spot capacity (GKE). Preemption gives at most 25 s, so celld's handoff is shortened to fit; the bucket keeps every acknowledged write."
  type        = bool
  default     = false
}

variable "tolerations" {
  description = "Pod tolerations, for example the architecture taint a managed cluster applies. Spot adds its own."
  type = list(object({
    key      = string
    value    = string
    operator = optional(string, "Equal")
    effect   = optional(string, "NoSchedule")
  }))
  default = []
}
