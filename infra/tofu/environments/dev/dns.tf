# DNS (INFRA-007): application zone and OOB subdomain delegation. Runbook: docs/runbooks/dns-delegation.md.
module "dns" {
  source = "../../modules/dns"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix    = local.name_prefix
  domain_name    = var.domain_name
  oob_server_ips = var.oob_server_ips
  # ingress_alias is wired by INFRA-012 once the ingress load balancer exists.
}
