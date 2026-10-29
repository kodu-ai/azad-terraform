output "certificates" {
  description = "Regional certificate names for the Gateway's HTTPS listener (tls option networking.gke.io/cert-manager-certs)."
  value       = [google_certificate_manager_certificate.regional.name]
}

output "dns_authorization_records" {
  description = "CNAME records that prove domain control; create them in the domain's DNS."
  value = {
    for domain, authorization in google_certificate_manager_dns_authorization.regional : domain => {
      name    = trimsuffix(authorization.dns_resource_record[0].name, ".")
      type    = authorization.dns_resource_record[0].type
      content = trimsuffix(authorization.dns_resource_record[0].data, ".")
    }
  }
}
