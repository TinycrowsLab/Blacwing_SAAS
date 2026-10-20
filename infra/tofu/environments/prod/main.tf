# prod environment root (INFRA-001).
#
# Shared files are symlinks to ../../: versions.tf (tool/provider pins), providers.tf (AWS provider
# with default_tags = common_tags), backend.tf (S3 state at blackwing/prod/terraform.tfstate with
# DynamoDB locking) and common_variables.tf (environment, aws_region, aws_account_id).
#
# Resources are added as module calls from ../../modules by the later INFRA issues (network
# INFRA-002, node pools INFRA-004, buckets INFRA-006, ...). Never declare a second provider or
# backend here.

locals {
  # Name prefix for every resource of this environment, e.g. "blackwing-prod-vpc".
  name_prefix = "blackwing-${var.environment}"
}

# Network backbone (INFRA-002): public / private-app / isolated sandbox subnets, NAT with static
# egress EIPs, VPC Flow Logs. Sizing comes from terraform.tfvars.
module "vpc" {
  source = "../../modules/vpc"

  name_prefix = local.name_prefix
  environment = var.environment
  cidr_block  = var.vpc_cidr_block
  az_count    = var.vpc_az_count
  single_nat  = var.vpc_single_nat
  eip_quota   = var.vpc_eip_quota
}

# Per-node-role security groups, IAM instance profiles and IMDSv2-only settings (INFRA-003). The
# node pools (INFRA-004) consume security_group_ids, instance_profile_names and metadata_options.
module "security" {
  source = "../../modules/security"

  name_prefix    = local.name_prefix
  vpc_id         = module.vpc.vpc_id
  vpc_cidr_block = module.vpc.vpc_cidr_block
  join_token_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/blackwing/${var.environment}/k3s/join-token",
  ]
}
