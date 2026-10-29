output "patterns" {
  description = "Hostname routes reserved for the Board, with no Worker attached."
  value       = [for route in cloudflare_workers_route.reserved : route.pattern]
}
