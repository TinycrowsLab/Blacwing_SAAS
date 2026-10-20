# Static egress-IP list for customers (INFRA-015, #50). The document is rendered from the vpc
# module's egress_ips output inside the same plan, so it cannot drift from the real EIPs, and it
# is served from a private S3 bucket behind CloudFront (static, no dependency on the app).
# Runbook: docs/runbooks/egress-ip-list.md.
# OFFLINE-STUB(online-porting #892): validated only with the mocked AWS provider; live apply and live drift check are an online step.

locals {
  fqdn = "${var.hostname_label}.${var.domain_name}"
  # Sorted and as /32 so the document is canonical and ordering never changes lastUpdated.
  egress_cidrs = [for ip in sort(var.egress_ips) : "${ip}/32"]
  object_key   = ".well-known/blackwing-egress-ips.json"
  bucket_name  = "bw-${var.environment}-egress-ips"
  origin_id    = "egress-ips-s3"

  document = {
    version     = 1
    lastUpdated = terraform_data.last_updated.output
    egressIps   = local.egress_cidrs
    notes       = var.notes
  }
  document_body = "${jsonencode(local.document)}\n"
}

# lastUpdated is stamped once and re-stamped only when the address set changes: the resource is
# replaced (and timestamp() re-evaluated) exactly when triggers_replace changes.
resource "terraform_data" "last_updated" {
  triggers_replace = local.egress_cidrs
  input            = formatdate("YYYY-MM-DD'T'hh:mm:ss'Z'", timestamp())

  lifecycle {
    ignore_changes = [input]
  }
}

resource "aws_s3_bucket" "this" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

# The content is public addresses only, so SSE-S3 is enough and keeps CloudFront OAC simple.
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_logging" "this" {
  bucket        = aws_s3_bucket.this.id
  target_bucket = var.access_log_bucket
  target_prefix = "s3/${local.bucket_name}/"
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_object" "document" {
  bucket        = aws_s3_bucket.this.id
  key           = local.object_key
  content       = local.document_body
  content_type  = "application/json"
  cache_control = "public, max-age=${var.cache_ttl_seconds}"

  depends_on = [aws_s3_bucket_server_side_encryption_configuration.this]
}

locals {
  bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      # Only the distribution may read, and only the one published object.
      {
        Sid       = "AllowCloudFrontReadDocument"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.this.arn}/${local.object_key}"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.this.arn } }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = jsonencode(local.bucket_policy)

  depends_on = [aws_s3_bucket_public_access_block.this]
}

resource "aws_acm_certificate" "this" {
  provider = aws.us_east_1

  domain_name       = local.fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => o
  }

  zone_id         = var.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_cloudfront_origin_access_control" "this" {
  name                              = "${local.bucket_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "this" {
  name        = "${local.bucket_name}-cache"
  min_ttl     = 0
  default_ttl = var.cache_ttl_seconds
  max_ttl     = var.cache_ttl_seconds

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "this" {
  name = "${local.bucket_name}-headers"

  cors_config {
    access_control_allow_credentials = false
    origin_override                  = true

    access_control_allow_headers {
      items = ["*"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }
    access_control_allow_origins {
      items = ["*"]
    }
  }

  security_headers_config {
    content_type_options {
      override = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=${var.cache_ttl_seconds}"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled      = true
  comment      = "Blackwing ${var.environment} static egress IP list"
  aliases      = [local.fqdn]
  http_version = "http2and3"
  price_class  = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.this.bucket_regional_domain_name
    origin_id                = local.origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  default_cache_behavior {
    target_origin_id           = local.origin_id
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.this.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.this.id
    # TLS only: plain HTTP is refused, never redirected, so a firewall script cannot be fed a
    # downgraded response.
    viewer_protocol_policy = "https-only"
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.this.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "alias" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.zone_id
  name    = local.fqdn
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
