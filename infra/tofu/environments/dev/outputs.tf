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

output "vpc_id" {
  description = "ID of this environment's VPC."
  value       = module.vpc.vpc_id
}

output "subnet_ids" {
  description = "Subnet IDs by tier (public, private-app, sandbox)."
  value       = module.vpc.subnet_ids
}

output "route_table_ids" {
  description = "Route table IDs by tier."
  value       = module.vpc.route_table_ids
}

output "egress_ips" {
  description = "Static egress EIPs customers allowlist (INFRA-015 publishes them)."
  value       = module.vpc.egress_ips
}

output "vpc_single_nat" {
  description = "Whether this environment shares one NAT gateway across AZs."
  value       = module.vpc.single_nat
}
