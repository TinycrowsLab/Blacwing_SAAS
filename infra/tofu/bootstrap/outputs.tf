output "state_bucket" {
  description = "Name of the remote state bucket (matches the bucket in ../backend.tf)."
  value       = aws_s3_bucket.state.id
}

output "state_bucket_arn" {
  description = "ARN of the remote state bucket."
  value       = aws_s3_bucket.state.arn
}

output "log_bucket" {
  description = "Name of the bucket receiving state-bucket access logs and CloudTrail files."
  value       = aws_s3_bucket.logs.id
}

output "lock_table" {
  description = "Name of the DynamoDB state lock table."
  value       = aws_dynamodb_table.lock.name
}

output "lock_table_arn" {
  description = "ARN of the DynamoDB state lock table."
  value       = aws_dynamodb_table.lock.arn
}

output "kms_key_arn" {
  description = "ARN of the KMS key encrypting state objects and the lock table."
  value       = aws_kms_key.state.arn
}

output "kms_alias" {
  description = "Alias of the state KMS key (referenced by ../backend.tf)."
  value       = aws_kms_alias.state.name
}

output "common_tags" {
  description = "Tags applied to every resource through the provider's default_tags."
  value       = local.common_tags
}
