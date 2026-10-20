# Storage buckets (INFRA-006): evidence (Object Lock), exports, backups and transcripts.
#
# Every bucket: versioning, SSE-KMS with its own CMK (rotation on), full public access block,
# TLS-only policy, deny of unencrypted PUT, S3 server access logging, lifecycle rules, and a
# 4xx request metric with an alarm. Object keys of evidence, exports and transcripts must start
# with t/<tenantId>/ (CONTEXT_PACK §8 #6); the KMS key policy additionally requires the
# tenantId encryption context. Both are defence in depth; the app layer is the primary control.
#
# Object Lock can only be enabled at bucket creation and cannot be disabled. The state bucket
# (bootstrap) is a different bucket and never has it. Buckets have prevent_destroy: replacing
# the evidence bucket would destroy tamper-evident evidence.
#
# S3 Bucket Keys are NOT used: with a bucket key S3 sends only the bucket ARN as encryption
# context, which cannot carry tenantId. KMS cost is bounded instead by the app using
# GenerateDataKey envelope encryption for bulk writes. See docs/architecture/storage-buckets.md.

locals {
  prefix = coalesce(var.name_prefix, "bw-${var.environment}")

  # Per-purpose settings. tenant_prefix: keys must start with t/<tenantId>/.
  buckets = {
    evidence    = { tenant_prefix = true }
    exports     = { tenant_prefix = true }
    backups     = { tenant_prefix = false }
    transcripts = { tenant_prefix = true }
  }

  retention_days = {
    exports     = var.exports_retention_days
    transcripts = var.transcripts_retention_days
    backups     = var.backups_retention_days
  }

  account_root_arn = "arn:aws:iam::${var.aws_account_id}:root"
}

# --- KMS: one CMK per bucket ----------------------------------------------------------------------

resource "aws_kms_key" "this" {
  for_each = local.buckets

  description             = "Blackwing ${var.environment} ${each.key} bucket"
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Key administration only. No data-plane crypto actions, so IAM policies in the account
        # cannot use this statement to bypass the tenantId condition below.
        Sid       = "AccountKeyAdministration"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action = [
          "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*",
          "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource",
          "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
        ]
        Resource = "*"
      },
      {
        Sid       = "AppRoleCryptoWithTenantContext"
        Effect    = "Allow"
        Principal = { AWS = var.app_role_arn }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          Null = { "kms:EncryptionContext:tenantId" = "false" }
        }
      },
      {
        Sid       = "DenyCryptoWithoutTenantContext"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey", "kms:GenerateDataKey*"]
        Resource  = "*"
        Condition = {
          Null = { "kms:EncryptionContext:tenantId" = "true" }
        }
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "this" {
  for_each = local.buckets

  name          = "alias/${local.prefix}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}

# --- Buckets ---------------------------------------------------------------------------------------

resource "aws_s3_bucket" "this" {
  for_each = local.buckets

  bucket = "${local.prefix}-${each.key}"
  # Evidence only; must be set at creation. Changing it later forces replacement, which
  # prevent_destroy refuses.
  object_lock_enabled = each.key == "evidence"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.buckets

  bucket = aws_s3_bucket.this[each.key].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = local.buckets

  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets

  bucket = aws_s3_bucket.this[each.key].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets

  bucket = aws_s3_bucket.this[each.key].id

  rule {
    bucket_key_enabled = false # see header: bucket keys cannot carry the tenantId context

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this[each.key].arn
    }
  }
}

# Evidence: COMPLIANCE default retention. No one, including root, can shorten it or remove a
# locked version. Retention is enforced by S3 server time, not by client clocks.
resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket              = aws_s3_bucket.this["evidence"].id
  object_lock_enabled = "Enabled"

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.evidence_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]

  lifecycle {
    precondition {
      condition     = var.evidence_noncurrent_expiration_days > var.evidence_retention_days
      error_message = "evidence_noncurrent_expiration_days must be greater than evidence_retention_days so lifecycle never races Object Lock."
    }
  }
}

resource "aws_s3_bucket_logging" "this" {
  for_each = local.buckets

  bucket        = aws_s3_bucket.this[each.key].id
  target_bucket = var.access_log_bucket
  # Must stay under s3-access/: the bootstrap log bucket policy only accepts delivery there.
  target_prefix = "s3-access/${aws_s3_bucket.this[each.key].id}/"
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = local.buckets

  bucket = aws_s3_bucket.this[each.key].id

  # Evidence: no expiration of current versions (the RETAIN epic deletes after retention_until).
  # Only non-current versions older than the Object Lock retention are cleaned up; S3 refuses to
  # delete a version that is still locked or under legal hold.
  dynamic "rule" {
    for_each = each.key == "evidence" ? [1] : []

    content {
      id     = "evidence-noncurrent-and-housekeeping"
      status = "Enabled"

      filter {}

      noncurrent_version_expiration {
        noncurrent_days = var.evidence_noncurrent_expiration_days
      }

      abort_incomplete_multipart_upload {
        days_after_initiation = 7
      }
    }
  }

  dynamic "rule" {
    for_each = each.key == "evidence" ? [] : [1]

    content {
      id     = "expire-${each.key}"
      status = "Enabled"

      filter {}

      expiration {
        days = local.retention_days[each.key]
      }

      noncurrent_version_expiration {
        noncurrent_days = var.noncurrent_version_expiration_days
      }

      abort_incomplete_multipart_upload {
        days_after_initiation = 7
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_policy" "this" {
  for_each = local.buckets

  bucket = aws_s3_bucket.this[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "DenyInsecureTransport"
          Effect    = "Deny"
          Principal = "*"
          Action    = "s3:*"
          Resource  = [aws_s3_bucket.this[each.key].arn, "${aws_s3_bucket.this[each.key].arn}/*"]
          Condition = { Bool = { "aws:SecureTransport" = "false" } }
        },
        {
          Sid       = "DenyUnencryptedPut"
          Effect    = "Deny"
          Principal = "*"
          Action    = "s3:PutObject"
          Resource  = "${aws_s3_bucket.this[each.key].arn}/*"
          Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } }
        },
        {
          Sid       = "DenyPutWithOtherKmsKey"
          Effect    = "Deny"
          Principal = "*"
          Action    = "s3:PutObject"
          Resource  = "${aws_s3_bucket.this[each.key].arn}/*"
          Condition = {
            StringNotEqualsIfExists = {
              "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.this[each.key].arn
            }
          }
        },
      ],
      local.buckets[each.key].tenant_prefix ? [
        {
          Sid         = "DenyKeysOutsideTenantPrefix"
          Effect      = "Deny"
          Principal   = "*"
          Action      = "s3:PutObject"
          NotResource = ["${aws_s3_bucket.this[each.key].arn}/t/*"]
        },
      ] : [],
      each.key == "evidence" ? [
        {
          Sid       = "DenyObjectLockWeakening"
          Effect    = "Deny"
          Principal = "*"
          Action    = ["s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration"]
          Resource  = [aws_s3_bucket.this[each.key].arn, "${aws_s3_bucket.this[each.key].arn}/*"]
        },
      ] : [],
    )
  })

  depends_on = [aws_s3_bucket_public_access_block.this]
}

# --- Observability ---------------------------------------------------------------------------------

resource "aws_s3_bucket_metric" "this" {
  for_each = local.buckets

  bucket = aws_s3_bucket.this[each.key].id
  name   = "EntireBucket"
}

resource "aws_cloudwatch_metric_alarm" "denied_requests" {
  for_each = local.buckets

  alarm_name          = "${local.prefix}-${each.key}-denied-requests"
  alarm_description   = "Elevated 4xx (including 403 AccessDenied) on the ${each.key} bucket."
  namespace           = "AWS/S3"
  metric_name         = "4xxErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.denied_requests_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  dimensions = {
    BucketName = aws_s3_bucket.this[each.key].id
    FilterId   = aws_s3_bucket_metric.this[each.key].name
  }
}

# S3 data events (object-level reads, writes, deletes, legal-hold and retention changes) for the
# four buckets, kept in a CloudTrail Lake event data store.
resource "aws_cloudtrail_event_data_store" "s3_data_events" {
  name                           = "${local.prefix}-s3-data-events"
  retention_period               = var.data_event_retention_days
  multi_region_enabled           = false
  organization_enabled           = false
  termination_protection_enabled = true

  advanced_event_selector {
    name = "S3 object-level events for the Blackwing storage buckets"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }

    field_selector {
      field = "resources.ARN"
      starts_with = [
        for name in sort(keys(local.buckets)) : "arn:aws:s3:::${local.prefix}-${name}/"
      ]
    }
  }
}
