mock_provider "kubernetes" {}

variables {
  name      = "azad-api"
  namespace = "azad"
  bucket    = "gs://azad-fleet-a1b2c3d4/api"
}

run "without_a_token_sidecar_the_pod_keeps_the_default_token" {
  command = plan
  variables {
    sidecars = [{ name = "helper", image = "example.com/helper:1" }]
  }
  assert {
    condition     = kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].automount_service_account_token
    error_message = "A fleet whose sidecars need no Kubernetes API keeps Kubernetes' default token mount."
  }
  assert {
    condition     = length([for volume in kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].volume : volume if volume.name == "kubernetes-api"]) == 0
    error_message = "No sidecar asked for the token, so none is projected."
  }
}

run "only_the_sidecar_that_asks_gets_the_kubernetes_token" {
  command = plan
  variables {
    sidecars = [
      {
        name                 = "updater-starter"
        image                = "ghcr.io/kodu-ai/azad-updater@sha256:${join("", [for _ in range(64) : "a"])}"
        args                 = ["update-host", "gke"]
        env                  = { AZAD_UPDATER_LISTEN = "127.0.0.1:8095" }
        run_as_user          = 65532
        kubernetes_api_token = true
      },
      { name = "helper", image = "example.com/helper:1" },
    ]
  }
  assert {
    condition     = !kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].automount_service_account_token
    error_message = "The pod automounts no token: celld and the other containers have no Kubernetes API credentials."
  }
  assert {
    condition = alltrue([
      for container in kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].container :
      length([for mount in container.volume_mount : mount if mount.name == "kubernetes-api"]) == (container.name == "updater-starter" ? 1 : 0)
    ])
    error_message = "Only the sidecar that asked mounts the projected token."
  }
  assert {
    condition = one([
      for container in kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].container :
      one(container.volume_mount).mount_path if container.name == "updater-starter"
    ]) == "/var/run/secrets/kubernetes.io/serviceaccount"
    error_message = "The token, CA and namespace sit where Kubernetes clients look for them."
  }
  assert {
    condition = length(one([
      for volume in kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].volume :
      volume.projected[0].sources if volume.name == "kubernetes-api"
    ])) == 3
    error_message = "The projected volume holds a bound token, the cluster CA and the namespace."
  }
  assert {
    condition = tostring(one([
      for container in kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].container :
      container.security_context[0].run_as_user if container.name == "updater-starter"
      ])) == "65532" && one([
      for container in kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].container :
      one(container.env).value if container.name == "updater-starter"
    ]) == "127.0.0.1:8095"
    error_message = "The sidecar runs as the given user with its environment."
  }
}

run "sidecar_names_cannot_shadow_the_fleet_containers" {
  command = plan
  variables {
    sidecars = [{ name = "celld", image = "example.com/helper:1" }]
  }
  expect_failures = [var.sidecars]
}
