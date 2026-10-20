variable "environment" {
  description = "Environment name (dev, staging, prod). Names the bucket."
  type        = string
  nullable    = false
}

variable "domain_name" {
  description = "Public application domain of this environment, for example blackwing.example."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain_name))
    error_message = "The domain_name must be a lower-case fully qualified domain without a trailing dot, for example blackwing.example."
  }
}

variable "zone_id" {
  description = "Hosted zone id of the application domain (dns module output app_zone_id)."
  type        = string
  nullable    = false
}

variable "egress_ips" {
  description = "The vpc module's egress_ips output, passed through unchanged. This is the only source of the published list: the module never accepts hand-written addresses."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.egress_ips) > 0
    error_message = "egress_ips must not be empty: an empty allowlist document would tell customers Blackwing has no source addresses."
  }

  validation {
    condition = alltrue([
      for ip in var.egress_ips :
      can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", ip)) && can(cidrhost("${ip}/32", 0)) && !anytrue([
        for private in ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"] :
        cidrcontains(private, ip)
      ])
    ])
    error_message = "Every egress IP must be a public IPv4 address. Private, loopback, link-local, CGNAT and multicast ranges must never be published."
  }
}

variable "hostname_label" {
  description = "Single DNS label under domain_name that serves the document, giving <label>.<domain_name>."
  type        = string
  default     = "egress"
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.hostname_label)) && !contains(["oob", "app", "api", "ns1", "ns2"], var.hostname_label)
    error_message = "hostname_label must be one lower-case DNS label that does not collide with oob, app, api, ns1 or ns2."
  }
}

variable "cache_ttl_seconds" {
  description = "Cache-Control max-age of the document, at the CDN and for clients. Also the documented propagation delay after an EIP change."
  type        = number
  default     = 3600
  nullable    = false

  validation {
    condition     = var.cache_ttl_seconds >= 60 && var.cache_ttl_seconds <= 86400
    error_message = "cache_ttl_seconds must be between 60 and 86400."
  }
}

variable "notes" {
  description = "Free text shipped in the document's notes field."
  type        = string
  default     = "Source addresses of all Blackwing target traffic. Allowlist these /32 ranges. Re-fetch this document periodically; changes can take up to one cache TTL to appear."
  nullable    = false
}

variable "access_log_bucket" {
  description = "Name of the S3 server access log bucket (created by bootstrap)."
  type        = string
  nullable    = false
}
