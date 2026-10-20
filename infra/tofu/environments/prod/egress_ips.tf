# Static egress-IP list for customers (INFRA-015, #50). Rendered from the vpc module's
# egress_ips output, so it cannot drift from the real EIPs. Runbook: docs/runbooks/egress-ip-list.md.
module "egress_ips" {
  source = "../../modules/egress-ips"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment       = var.environment
  domain_name       = var.domain_name
  zone_id           = module.dns.app_zone_id
  egress_ips        = module.vpc.egress_ips
  access_log_bucket = local.storage_log_bucket
}

output "egress_ips_url" {
  description = "Public URL of the egress-IP list customers allowlist (INFRA-015)."
  value       = module.egress_ips.url
}

output "egress_ips_published" {
  description = "CIDRs written to the published document; the drift check compares these with egress_ips."
  value       = module.egress_ips.published_egress_ips
}
