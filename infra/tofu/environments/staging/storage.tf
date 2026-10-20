# Evidence, exports, backups and transcripts buckets (INFRA-006). See modules/storage.
#
# app_role_arn points at the application role created by the IAM/workload-identity issue
# (INFRA-010). That role must exist before the first apply, or the KMS key policy is rejected.
# The access log bucket is the one created by bootstrap (INFRA-001).

locals {
  storage_app_role_arn   = "arn:aws:iam::${var.aws_account_id}:role/blackwing-${var.environment}-app"
  storage_log_bucket     = "blackwing-tfstate-logs-${var.aws_account_id}-${var.aws_region}"
  storage_retention_days = var.evidence_retention_days
}

variable "evidence_retention_days" {
  description = "Default Object Lock COMPLIANCE retention of the evidence bucket, in days. Irreversible once objects are written."
  type        = number
  default     = 30
}

module "storage" {
  source = "../../modules/storage"

  environment             = var.environment
  aws_account_id          = var.aws_account_id
  app_role_arn            = local.storage_app_role_arn
  access_log_bucket       = local.storage_log_bucket
  evidence_retention_days = local.storage_retention_days
}

output "storage_bucket_names" {
  description = "Bucket names by purpose, for Helm values and app config."
  value       = module.storage.bucket_names
}

output "storage_kms_key_arns" {
  description = "Per-purpose KMS CMK ARNs, for Helm values and app config."
  value       = module.storage.kms_key_arns
}
