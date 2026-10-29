terraform {
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.4.0"
    }
  }
}
