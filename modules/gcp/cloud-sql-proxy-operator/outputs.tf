output "ready" {
  description = "The operator's namespace once its controller and webhooks are running; depend on it before creating AuthProxyWorkloads."
  value       = local.namespace
  depends_on  = [module.operator]
}
