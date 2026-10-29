output "address" {
  description = "Where the API reaches the machine over SSH: its internal address, port, user and host key (the host key line people can compare with what Azad's machine test shows)."
  value = {
    host     = google_compute_instance.agents.network_interface[0].network_ip
    port     = 22
    user     = var.user
    host_key = trimspace(tls_private_key.host.public_key_openssh)
  }
}

output "private_key" {
  description = "The OpenSSH private key for the user, to paste into project setup's SSH form."
  sensitive   = true
  value       = tls_private_key.client.private_key_openssh
}
