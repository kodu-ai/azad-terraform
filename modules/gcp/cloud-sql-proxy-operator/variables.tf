variable "release" {
  description = "Cloud SQL Proxy Operator release and the SHA-256 of its published install manifest. Bump both together."
  type = object({
    version = string
    sha256  = string
  })
  default = {
    version = "v1.8.4"
    sha256  = "07dd881589a7cc4a17fb9db516b04d3f7b91e60aa52f048fd8555e4a30e079ce"
  }
}
