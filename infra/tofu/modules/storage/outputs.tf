output "bucket_names" {
  description = "Bucket names by purpose (evidence, exports, backups, transcripts)."
  value       = { for k, b in aws_s3_bucket.this : k => b.id }
}

output "bucket_arns" {
  description = "Bucket ARNs by purpose."
  value       = { for k, b in aws_s3_bucket.this : k => b.arn }
}

output "kms_key_arns" {
  description = "Per-purpose KMS CMK ARNs."
  value       = { for k, key in aws_kms_key.this : k => key.arn }
}

output "kms_key_aliases" {
  description = "Per-purpose KMS key aliases."
  value       = { for k, a in aws_kms_alias.this : k => a.name }
}

output "tenant_prefix_template" {
  description = "Object key prefix of every tenant's data in evidence, exports and transcripts. Substitute the tenant ID; never put PII in keys."
  value       = "t/<tenantId>/"
}

output "encryption_context_key" {
  description = "KMS encryption context key every data-plane crypto call must carry."
  value       = "tenantId"
}

output "evidence_retention_days" {
  description = "Default COMPLIANCE retention of the evidence bucket, in days."
  value       = var.evidence_retention_days
}

output "data_event_store_arn" {
  description = "CloudTrail Lake event data store holding S3 data events."
  value       = aws_cloudtrail_event_data_store.s3_data_events.arn
}
