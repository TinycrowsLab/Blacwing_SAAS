# One-time bootstrap of the remote state backend (INFRA-001), once per AWS account and region.
#
# Creates the KMS key, the versioned and encrypted state bucket, its access-log bucket, the
# DynamoDB lock table and a CloudTrail trail recording every object-level access to the state.
# The first apply runs on local state (see README.md "Bootstrap"); the state is then migrated into
# the bucket it created, so later runs from any clone see the same state and change nothing.
#
# Every stateful resource has prevent_destroy: re-running bootstrap never recreates or deletes the
# bucket, table or key. Object Lock is never enabled on the state bucket: it would block state
# overwrites. Object Lock is for evidence buckets only (INFRA-006).

locals {
  name_suffix      = "${var.aws_account_id}-${var.aws_region}"
  state_bucket     = "blackwing-tfstate-${local.name_suffix}"
  log_bucket       = "blackwing-tfstate-logs-${local.name_suffix}"
  lock_table       = "blackwing-tfstate-lock"
  kms_alias        = "alias/blackwing-tfstate"
  trail_name       = "blackwing-tfstate-access"
  trail_arn        = "arn:aws:cloudtrail:${var.aws_region}:${var.aws_account_id}:trail/${local.trail_name}"
  account_root_arn = "arn:aws:iam::${var.aws_account_id}:root"
}

# --- KMS key for state objects and the lock table -------------------------------------------------

resource "aws_kms_key" "state" {
  description             = "Blackwing OpenTofu state (S3 objects and DynamoDB lock table)"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action    = "kms:*"
        Resource  = "*"
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = local.kms_alias
  target_key_id = aws_kms_key.state.key_id
}

# --- Access-log bucket (S3 server access logs and the CloudTrail trail) ----------------------------
# Log delivery only supports SSE-S3 on the target bucket, so this bucket uses AES256.

resource "aws_s3_bucket" "logs" {
  bucket = local.log_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_log_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.logs]
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "S3ServerAccessLogDelivery"
        Effect    = "Allow"
        Principal = { Service = "logging.s3.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.logs.arn}/s3-access/*"
        Condition = {
          ArnLike      = { "aws:SourceArn" = aws_s3_bucket.state.arn }
          StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        }
      },
      {
        Sid       = "CloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.logs.arn
        Condition = { StringEquals = { "aws:SourceArn" = local.trail_arn } }
      },
      {
        Sid       = "CloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.logs.arn}/cloudtrail/AWSLogs/${var.aws_account_id}/*"
        Condition = { StringEquals = { "aws:SourceArn" = local.trail_arn } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.logs]
}

# --- State bucket ----------------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  # Never Object Lock on the state bucket: OpenTofu must overwrite the state object.
  object_lock_enabled = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

resource "aws_s3_bucket_logging" "state" {
  bucket        = aws_s3_bucket.state.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access/"

  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyObjectWritesWithoutKms"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.state.arn}/*"
        Condition = {
          StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }
        }
      },
      {
        # Only the ops role(s) may touch state. Include the principal that runs bootstrap, or the
        # next bootstrap run locks itself out (recoverable only by the account root user).
        Sid       = "DenyEveryoneButOpsRoles"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
        Condition = { ArnNotLike = { "aws:PrincipalArn" = var.state_admin_principal_arns } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

# --- Lock table ------------------------------------------------------------------------------------

resource "aws_dynamodb_table" "lock" {
  name                        = local.lock_table
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "LockID"
  deletion_protection_enabled = true

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state.arn
  }

  lifecycle {
    prevent_destroy = true
  }
}

# --- Audit: CloudTrail data events for every object access in the state bucket ---------------------

resource "aws_cloudtrail" "state_access" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.logs.id
  s3_key_prefix                 = "cloudtrail"
  include_global_service_events = false
  is_multi_region_trail         = false
  enable_log_file_validation    = true

  advanced_event_selector {
    name = "State bucket object access"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }

    field_selector {
      field       = "resources.ARN"
      starts_with = ["${aws_s3_bucket.state.arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.logs]
}
