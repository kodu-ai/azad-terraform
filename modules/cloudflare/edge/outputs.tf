output "origin_tls" {
  description = "Certificate and key for the origin load balancer."
  sensitive   = true
  value = {
    certificate = cloudflare_origin_ca_certificate.origin.certificate
    private_key = tls_private_key.origin.private_key_pem
  }
}

output "hosts" {
  description = "Hostnames now proxied to the origin."
  value       = var.hosts
}
