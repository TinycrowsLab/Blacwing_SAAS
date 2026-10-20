output "app_zone_id" {
  description = "Hosted zone id of the application domain (consumed by INFRA-008 SES and INFRA-012 TLS/ingress)."
  value       = aws_route53_zone.app.zone_id
}

output "app_zone_name" {
  description = "Application domain name."
  value       = aws_route53_zone.app.name
}

output "app_zone_arn" {
  description = "ARN of the application hosted zone (for scoped IAM policies, e.g. cert-manager DNS-01)."
  value       = aws_route53_zone.app.arn
}

output "app_name_servers" {
  description = "Name servers to set at the domain registrar. Manual step; see docs/runbooks/dns-delegation.md."
  value       = aws_route53_zone.app.name_servers
}

output "oob_domain" {
  description = "Delegated OOB subdomain, for example oob.blackwing.example."
  value       = local.oob_fqdn
}

output "oob_wildcard_base" {
  description = "Wildcard base for the packages/oob client configuration: interactsh answers any label under it."
  value       = "*.${local.oob_fqdn}"
}

output "oob_ns_set" {
  description = "Name servers the OOB subdomain is delegated to (what dig NS returns for the OOB domain)."
  value       = aws_route53_record.oob_delegation.records
}

output "oob_server_ips" {
  description = "Public addresses behind the OOB name servers; empty until INFRA-010 sets them."
  value       = var.oob_server_ips
}

output "ses_dns_placeholder" {
  description = "Inputs INFRA-008 needs to add its DKIM, MAIL FROM and verification records to the app zone."
  value = {
    zone_id = aws_route53_zone.app.zone_id
    domain  = aws_route53_zone.app.name
  }
}

output "query_log_group_name" {
  description = "CloudWatch log group (us-east-1) receiving the zone's query log."
  value       = aws_cloudwatch_log_group.query.name
}
