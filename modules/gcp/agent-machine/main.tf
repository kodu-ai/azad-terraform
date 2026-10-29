# One Compute Engine machine where the installation's agents run: the API
# reaches it over SSH on its internal address, the way it reaches any server a
# person connects as "A server over SSH".

data "google_compute_zones" "available" {
  project = var.project_id
  region  = var.region
  status  = "UP"
}

# The API signs in with this key. The machine's host key is generated here too,
# so the API pins it from the first connection instead of trusting it on first
# use.
resource "tls_private_key" "client" {
  algorithm = "ED25519"
}

resource "tls_private_key" "host" {
  algorithm = "ED25519"
}

locals {
  tag = "${var.name}-agents"
  # Installs the generated host key on every boot (after the guest agent's own
  # first-boot keys) and allows key sign-in only.
  startup_script = <<-SCRIPT
    #!/bin/bash
    set -euo pipefail
    umask 077
    curl -fsS -H 'Metadata-Flavor: Google' \
      http://metadata.google.internal/computeMetadata/v1/instance/attributes/azad-host-key \
      > /etc/ssh/ssh_host_ed25519_key
    ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key > /etc/ssh/ssh_host_ed25519_key.pub
    chmod 644 /etc/ssh/ssh_host_ed25519_key.pub
    printf 'HostKey /etc/ssh/ssh_host_ed25519_key\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' \
      > /etc/ssh/sshd_config.d/10-azad.conf
    systemctl try-reload-or-restart ssh.service
  SCRIPT
}

resource "google_compute_instance" "agents" {
  project                   = var.project_id
  name                      = local.tag
  zone                      = data.google_compute_zones.available.names[0]
  machine_type              = var.machine_type
  tags                      = [local.tag]
  deletion_protection       = var.deletion_protection
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.disk_size_gb
      type  = "pd-balanced"
    }
  }

  # No public address: outbound traffic leaves through the Cloud NAT below,
  # and nothing on the internet can reach SSH.
  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin = "FALSE"
    ssh-keys       = "${var.user}:${trimspace(tls_private_key.client.public_key_openssh)}"
    azad-host-key  = tls_private_key.host.private_key_openssh
    startup-script = local.startup_script
  }

  # No service_account block: agents on this machine get no Google Cloud
  # identity. A newer Ubuntu image never replaces the machine and its disk.
  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}

resource "google_compute_firewall" "ssh" {
  project       = var.project_id
  name          = "${local.tag}-ssh"
  network       = var.network
  direction     = "INGRESS"
  source_ranges = var.ssh_source_ranges
  target_tags   = [local.tag]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_router" "egress" {
  project = var.project_id
  name    = "${local.tag}-egress"
  region  = var.region
  network = var.network
}

resource "google_compute_router_nat" "egress" {
  project                            = var.project_id
  name                               = "${local.tag}-egress"
  router                             = google_compute_router.egress.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = var.subnetwork
    source_ip_ranges_to_nat = ["PRIMARY_IP_RANGE"]
  }
}
