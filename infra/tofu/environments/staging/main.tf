# staging environment root (INFRA-001).
#
# Shared files are symlinks to ../../: versions.tf (tool/provider pins), providers.tf (AWS provider
# with default_tags = common_tags), backend.tf (S3 state at blackwing/staging/terraform.tfstate with
# DynamoDB locking) and common_variables.tf (environment, aws_region, aws_account_id).
#
# Resources are added as module calls from ../../modules by the later INFRA issues (network
# INFRA-002, node pools INFRA-004, buckets INFRA-006, ...). Never declare a second provider or
# backend here.

locals {
  # Name prefix for every resource of this environment, e.g. "blackwing-staging-vpc".
  name_prefix = "blackwing-${var.environment}"
}
