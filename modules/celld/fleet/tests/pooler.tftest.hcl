mock_provider "kubernetes" {}

variables {
  name      = "azad-api"
  namespace = "azad"
  bucket    = "gs://azad-fleet-a1b2c3d4/api"
}

run "without_a_pooler_the_pod_runs_celld_alone" {
  command = plan
  assert {
    condition     = length(kubernetes_config_map_v1.pooler) == 0 && length(kubernetes_secret_v1.pooler) == 0
    error_message = "No pooler, no PgBouncer configuration."
  }
  assert {
    condition     = length(kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].init_container) == 0
    error_message = "No pooler, no PgBouncer container."
  }
  assert {
    condition     = output.database_endpoint == null
    error_message = "Without a pooler the Worker keeps its own database endpoint."
  }
}

run "the_pooler_sits_between_the_worker_and_the_local_endpoint" {
  command = plan
  variables {
    database_pooler          = { database = "azad", username = "azad" }
    database_pooler_password = "fixture\"password"
  }
  assert {
    condition     = output.database_endpoint == "127.0.0.1:6432"
    error_message = "The Worker connects to PgBouncer on the pod's loopback."
  }
  assert {
    condition = alltrue([for line in [
      "azad = host=127.0.0.1 port=5432 dbname=azad",
      "listen_addr = 127.0.0.1",
      "listen_port = 6432",
      "pool_mode = transaction",
      "default_pool_size = 20",
      "auth_type = scram-sha-256",
      "auth_file = /etc/pgbouncer-auth/userlist.txt",
      "server_tls_sslmode = disable",
    ] : strcontains(kubernetes_config_map_v1.pooler[0].data["pgbouncer.ini"], "\n${line}\n")])
    error_message = "PgBouncer pools transactions on loopback toward the proxy on 127.0.0.1:5432, which adds TLS itself."
  }
  assert {
    condition     = nonsensitive(kubernetes_secret_v1.pooler[0].data["userlist.txt"] == "\"azad\" \"fixture\"\"password\"\n")
    error_message = "The auth file holds the user and password in PgBouncer's quoted format."
  }
}

run "the_pooler_outlives_celld_in_the_pod" {
  command = plan
  variables {
    database_pooler          = { database = "azad", username = "azad" }
    database_pooler_password = "fixture-password"
  }
  assert {
    condition     = kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].init_container[0].name == "pgbouncer" && kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].init_container[0].restart_policy == "Always"
    error_message = "PgBouncer is a native sidecar: it starts before celld and stops after it, so the shutdown handoff keeps the database."
  }
  assert {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", kubernetes_stateful_set_v1.fleet.spec[0].template[0].spec[0].init_container[0].image))
    error_message = "The PgBouncer image is pinned by digest."
  }
}

run "a_pooler_needs_the_database_password" {
  command = plan
  variables {
    database_pooler = { database = "azad", username = "azad" }
  }
  expect_failures = [var.database_pooler_password]
}
