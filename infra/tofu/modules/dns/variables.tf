variable "name_prefix" {
  description = "Name prefix of the environment, for example blackwing-dev. Used to name the query-log group."
  type        = string
  nullable    = false
}

variable "domain_name" {
  description = "Public application domain of this environment, for example blackwing.example. Every environment must use its own domain so a dev OOB token can never resolve in prod."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain_name))
    error_message = "The domain_name must be a lower-case fully qualified domain without a trailing dot, for example blackwing.example."
  }
}

variable "oob_subdomain_label" {
  description = "Single DNS label of the out-of-band subdomain delegated to interactsh, giving oob.<domain_name>."
  type        = string
  default     = "oob"
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.oob_subdomain_label))
    error_message = "The oob_subdomain_label must be one lower-case DNS label (no dots)."
  }
}

variable "oob_server_ips" {
  description = "Public IPv4 addresses of the interactsh servers (one or two). Empty until INFRA-010 deploys interactsh: the delegation exists, but the name-server glue records are created only once addresses are set."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition     = length(var.oob_server_ips) <= 2
    error_message = "At most two interactsh addresses are supported (ns1 and ns2)."
  }

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

variable "ingress_alias" {
  description = "Ingress load balancer alias target, filled in by INFRA-012. Null creates no ingress records."
  type = object({
    dns_name = string
    zone_id  = string
  })
  default = null
}

variable "ingress_hostnames" {
  description = "Host labels pointed at the ingress alias; an empty string means the zone apex. The labels must not equal the OOB subdomain label."
  type        = list(string)
  default     = ["", "app", "api"]
  nullable    = false
}

variable "query_log_retention_days" {
  description = "Retention of the Route53 query log (feeds OOB correlation and abuse detection)."
  type        = number
  default     = 90
  nullable    = false

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.query_log_retention_days)
    error_message = "The query_log_retention_days must be a retention value CloudWatch Logs accepts."
  }
}
