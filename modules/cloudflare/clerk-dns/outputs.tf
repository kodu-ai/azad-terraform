output "records" {
  description = "Clerk CNAMEs owned by this composition."
  value = { for name, record in cloudflare_dns_record.clerk : name => {
    content = record.content
    proxied = record.proxied
  } }
}
