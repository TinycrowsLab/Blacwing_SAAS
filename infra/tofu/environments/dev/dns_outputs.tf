output "dns_app_zone_id" {
  description = "Hosted zone id of the application domain (for INFRA-008 and INFRA-012)."
  value       = module.dns.app_zone_id
}

output "dns_app_name_servers" {
  description = "Name servers to set at the registrar (manual step, docs/runbooks/dns-delegation.md)."
  value       = module.dns.app_name_servers
}

output "dns_oob_domain" {
  description = "Delegated OOB subdomain."
  value       = module.dns.oob_domain
}

output "dns_oob_wildcard_base" {
  description = "Wildcard base for the packages/oob client configuration."
  value       = module.dns.oob_wildcard_base
}

output "dns_oob_ns_set" {
  description = "Name servers the OOB subdomain is delegated to."
  value       = module.dns.oob_ns_set
}
