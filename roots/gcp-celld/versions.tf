terraform {
  # State lives where `init -backend-config=path=...` puts it: the drivers
  # (scripts/cloudflare.ts, scripts/gcp.ts) keep it in the instance directory.
  backend "local" {}
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7.2"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.4.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.6.3"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.1.0"
    }
  }
}
