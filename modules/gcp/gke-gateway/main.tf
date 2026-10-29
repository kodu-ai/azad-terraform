# GKE Gateway (regional external Application Load Balancer) in front of the
# celld fleets, in the cluster's region. celld does not terminate TLS; the load
# balancer does, with regional Certificate Manager certificates (Google-managed)
# or an origin certificate presented to a proxying CDN.

locals {
  # A Gateway cannot change class, so another kind of load balancer is another
  # Gateway, and the class is in its name and its routes' names.
  gateway  = "${var.name}-regional"
  https    = var.tls != null || length(var.certificates) > 0
  services = toset([for route in var.routes : route.service])
  hosts = {
    for service in local.services : service => [for route in var.routes : route.host if route.service == service]
  }
  ports = { for route in var.routes : route.service => route.port... }
}

resource "kubernetes_secret_v1" "tls" {
  count = var.tls == null ? 0 : 1
  metadata {
    name      = "${var.name}-origin-tls"
    namespace = var.namespace
  }
  type = "kubernetes.io/tls"
  data = {
    "tls.crt" = var.tls.certificate
    "tls.key" = var.tls.private_key
  }
}

# The Gateway and its routes are created before the ones they replace are
# destroyed, which happens only after everything that depends on them (the
# caller's readiness check and DNS) has moved: a replaced load balancer keeps
# serving its routes while this one is built.
resource "kubernetes_manifest" "gateway" {
  manifest = {
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "Gateway"
    metadata = {
      name      = local.gateway
      namespace = var.namespace
    }
    spec = {
      gatewayClassName = "gke-l7-regional-external-managed"
      addresses        = [{ type = "NamedAddress", value = var.static_ip_name }]
      listeners = concat(
        [{ name = "http", protocol = "HTTP", port = 80 }],
        local.https ? [{
          name     = "https"
          protocol = "HTTPS"
          port     = 443
          tls = merge(
            { mode = "Terminate" },
            var.tls == null ? {} : {
              certificateRefs = [{ kind = "Secret", name = kubernetes_secret_v1.tls[0].metadata[0].name }]
            },
            # Regional Gateways take Certificate Manager certificates by name.
            var.tls == null ? { options = { "networking.gke.io/cert-manager-certs" = join(",", var.certificates) } } : {},
          )
        }] : [],
      )
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "kubernetes_manifest" "route" {
  for_each = local.services
  manifest = {
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "${local.gateway}-${each.value}"
      namespace = var.namespace
    }
    spec = {
      parentRefs = [{ name = kubernetes_manifest.gateway.manifest.metadata.name, sectionName = local.https ? "https" : "http" }]
      hostnames  = local.hosts[each.value]
      rules      = [{ backendRefs = [{ name = each.value, port = local.ports[each.value][0] }] }]
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Plain HTTP only redirects once HTTPS is served.
resource "kubernetes_manifest" "redirect" {
  count = local.https ? 1 : 0
  manifest = {
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "${local.gateway}-https-redirect"
      namespace = var.namespace
    }
    spec = {
      parentRefs = [{ name = kubernetes_manifest.gateway.manifest.metadata.name, sectionName = "http" }]
      rules = [{
        filters = [{
          type            = "RequestRedirect"
          requestRedirect = { scheme = "https", statusCode = 301 }
        }]
      }]
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# celld answers its own health endpoint on the serving port. Both policies
# target the Service, so they apply to every Gateway that routes to it. The
# Gateway controller opens the VPC firewall to Google's health checkers and the
# region's proxy-only subnet.
resource "kubernetes_manifest" "health_check" {
  for_each = local.services
  manifest = {
    apiVersion = "networking.gke.io/v1"
    kind       = "HealthCheckPolicy"
    metadata = {
      name      = each.value
      namespace = var.namespace
    }
    spec = {
      default = {
        checkIntervalSec = 5
        config = {
          type            = "HTTP"
          httpHealthCheck = { requestPath = "/.well-known/celld/health" }
        }
      }
      targetRef = { group = "", kind = "Service", name = each.value }
    }
  }
}

# Realtime WebSockets stay open for at most the backend timeout, then clients
# reconnect; draining lets in-flight requests finish when a node leaves.
resource "kubernetes_manifest" "backend" {
  for_each = local.services
  manifest = {
    apiVersion = "networking.gke.io/v1"
    kind       = "GCPBackendPolicy"
    metadata = {
      name      = each.value
      namespace = var.namespace
    }
    spec = {
      default = {
        timeoutSec         = var.backend_timeout_seconds
        connectionDraining = { drainingTimeoutSec = 60 }
      }
      targetRef = { group = "", kind = "Service", name = each.value }
    }
  }
}
