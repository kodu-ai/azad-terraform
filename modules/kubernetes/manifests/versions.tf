terraform {
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3.0"
    }
  }
}
