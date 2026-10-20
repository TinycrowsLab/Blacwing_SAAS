# SES sender (INFRA-008): domain identity, DKIM, SPF, DMARC, MAIL FROM, configuration set and SMTP
# credentials (SSM SecureString references). Runbook: docs/runbooks/ses-email.md.
module "email" {
  source = "../../modules/email"

  name_prefix      = local.name_prefix
  domain_name      = var.domain_name
  zone_id          = module.dns.app_zone_id
  aws_region       = var.aws_region
  aws_account_id   = var.aws_account_id
  parameter_prefix = "/blackwing/${var.environment}/email"
  # Only prod enforces quarantine; dev and staging report-only while mail flows are validated.
  dmarc_policy = var.environment == "prod" ? "quarantine" : "none"
}
