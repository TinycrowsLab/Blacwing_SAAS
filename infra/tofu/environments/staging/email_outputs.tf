output "email_smtp_host" {
  description = "SES SMTP endpoint for Nodemailer."
  value       = module.email.smtp_host
}

output "email_smtp_port" {
  description = "SES SMTP port (STARTTLS)."
  value       = module.email.smtp_port
}

output "email_configuration_set" {
  description = "SES configuration set name (X-SES-Configuration-Set header)."
  value       = module.email.configuration_set_name
}

output "email_from_address" {
  description = "Default from-address on the verified domain."
  value       = module.email.from_address
}

output "email_smtp_username_parameter" {
  description = "SSM parameter name of the SMTP username (reference only)."
  value       = module.email.smtp_username_parameter
}

output "email_smtp_password_parameter" {
  description = "SSM parameter name of the SMTP password (reference only)."
  value       = module.email.smtp_password_parameter
}
