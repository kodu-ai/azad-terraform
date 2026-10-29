output "cluster" {
  description = "Connection details for the Kubernetes provider."
  value = {
    id       = google_container_cluster.celld.id
    name     = google_container_cluster.celld.name
    location = google_container_cluster.celld.location
    endpoint = "https://${google_container_cluster.celld.endpoint}"
    # Unknown until the cluster exists; providers without auth data (mocks) yield null.
    cluster_ca_certificate = try(base64decode(google_container_cluster.celld.master_auth[0].cluster_ca_certificate), null)
  }
}

output "bucket" {
  description = "Fleet bucket; each fleet uses gs://BUCKET/<fleet>."
  value       = google_storage_bucket.fleet.name
}

output "ingress_address" {
  description = "Regional static IP of the HTTPS load balancer, and its name for the Gateway's NamedAddress."
  value = {
    name    = google_compute_address.ingress.name
    address = google_compute_address.ingress.address
  }
}

output "network" {
  description = "The cluster's VPC, subnetwork and pod range, for machines its pods reach over internal addresses."
  value = {
    network    = coalesce(google_container_cluster.celld.network, local.network)
    subnetwork = google_container_cluster.celld.subnetwork
    pod_cidr   = google_container_cluster.celld.cluster_ipv4_cidr
  }
}
