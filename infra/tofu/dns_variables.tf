# DNS inputs shared by every environment root (INFRA-007). Symlinked into each root. The values
# differ per environment in terraform.tfvars: every environment needs its own domain.

variable "domain_name" {
  description = "Public application domain of this environment. Distinct per environment so a dev OOB token can never resolve in prod."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain_name))
    error_message = "The domain_name must be a lower-case fully qualified domain without a trailing dot, for example blackwing.example."
  }
}

variable "oob_server_ips" {
  description = "Public IPv4 addresses of the interactsh servers (at most two), set by INFRA-010. Empty until then."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition = alltrue([
      for ip in var.oob_server_ips :
      can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", ip)) && can(cidrhost("${ip}/32", 0)) && !anytrue([
        for private in ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"] :
        cidrcontains(private, ip)
      ])
    ])
    error_message = "Each oob_server_ips entry must be a public IPv4 address: the OOB listener must be reachable from the Internet and never point at private space."
  }
}
