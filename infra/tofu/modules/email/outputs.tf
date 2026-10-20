output "smtp_host" {
  description = "SES SMTP endpoint for Nodemailer (SMTP_HOST)."
  value       = local.smtp_host
}

output "smtp_port" {
  description = "SES SMTP submission port using STARTTLS (SMTP_PORT)."
  value       = 587
}

output "configuration_set_name" {
  description = "SES configuration set; Nodemailer sends it in the X-SES-Configuration-Set header so bounce/complaint events are published."
  value       = aws_ses_configuration_set.this.name
}

output "from_address" {
  description = "Default from-address on the verified domain (EMAIL_FROM)."
  value       = local.from_address
}

output "mail_from_domain" {
  description = "Custom MAIL FROM (envelope sender) domain."
  value       = local.mail_from_domain
}

output "events_topic_arn" {
  description = "SNS topic receiving bounce, complaint and reject events and the reputation alarms."
  value       = aws_sns_topic.events.arn
}

output "identity_arn" {
  description = "ARN of the SES domain identity."
  value       = aws_ses_domain_identity.this.arn
}

output "smtp_username_parameter" {
  description = "SSM parameter NAME (not the value) holding the SMTP username. Read it by reference."
  value       = aws_ssm_parameter.smtp_username.name
}

output "smtp_password_parameter" {
  description = "SSM parameter NAME (not the value) holding the SMTP password. Read it by reference."
  value       = aws_ssm_parameter.smtp_password.name
}

output "dmarc_record" {
  description = "Published DMARC TXT value at _dmarc.<domain>."
  value       = local.dmarc_record
}

output "smtp_next_parameters" {
  description = "SSM parameter names of the overlap key pair during a rotation; empty otherwise."
  value       = var.rotation_overlap ? [aws_ssm_parameter.smtp_username_next[0].name, aws_ssm_parameter.smtp_password_next[0].name] : []
}
