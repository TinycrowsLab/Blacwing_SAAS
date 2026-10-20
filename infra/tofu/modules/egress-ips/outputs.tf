output "url" {
  description = "Public URL customers fetch."
  value       = "https://${local.fqdn}/${local.object_key}"
}

output "published_egress_ips" {
  description = "The CIDRs written to the document (sorted /32s). Compared against egress_ips by the drift test."
  value       = local.egress_cidrs
}

output "document" {
  description = "The exact JSON document body that is published."
  value       = local.document_body
}

output "last_updated" {
  description = "lastUpdated stamp inside the document; changes only when the address set changes."
  value       = terraform_data.last_updated.output
}

output "bucket_name" {
  description = "Private bucket that holds the document."
  value       = aws_s3_bucket.this.bucket
}

output "distribution_id" {
  description = "CloudFront distribution serving the document."
  value       = aws_cloudfront_distribution.this.id
}
