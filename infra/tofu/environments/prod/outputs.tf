output "environment" {
  description = "Environment this root manages."
  value       = var.environment
}

output "aws_region" {
  description = "AWS region of this environment."
  value       = var.aws_region
}

output "name_prefix" {
  description = "Name prefix for this environment's resources."
  value       = local.name_prefix
}

output "common_tags" {
  description = "Tags every resource receives through the provider's default_tags."
  value       = local.common_tags
}

output "state_key" {
  description = "Object key of this environment's state in the state bucket."
  value       = "blackwing/${var.environment}/terraform.tfstate"
}
