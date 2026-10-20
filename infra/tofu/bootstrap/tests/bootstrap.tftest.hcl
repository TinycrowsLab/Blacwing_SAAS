# Offline tests for the bootstrap root (INFRA-001). Every run is a plan: OpenTofu's mock provider
# fills computed attributes at plan time, and a plan never has to destroy the prevent_destroy
# resources in teardown. The AWS provider is mocked: these prove the
# configuration (versioning, KMS SSE, public-access block, lifecycle, lock table shape, no Object
# Lock, idempotent re-apply), not AWS behaviour. Real-account verification is tracked in the
# online-porting issue referenced from ../../README.md.

# The mocked provider invents random strings for computed attributes; the ones the provider
# validates as ARNs need ARN-shaped defaults.
mock_provider "aws" {
  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:eu-central-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      key_id = "00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::blackwing-mock-bucket"
    }
  }

  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn = "arn:aws:dynamodb:eu-central-1:123456789012:table/blackwing-tfstate-lock"
    }
  }

  mock_resource "aws_cloudtrail" {
    defaults = {
      arn = "arn:aws:cloudtrail:eu-central-1:123456789012:trail/blackwing-tfstate-access"
    }
  }
}

variables {
  environment                = "dev"
  aws_region                 = "eu-central-1"
  aws_account_id             = "123456789012"
  state_admin_principal_arns = ["arn:aws:iam::123456789012:role/blackwing-ops"]
}

run "state_bucket_is_versioned_encrypted_and_private" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "blackwing-tfstate-123456789012-eu-central-1"
    error_message = "State bucket name must match the bucket in backend.tf."
  }

  assert {
    condition     = aws_s3_bucket.state.object_lock_enabled == false
    error_message = "Object Lock must never be enabled on the state bucket."
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State bucket versioning must be enabled."
  }

  assert {
    condition = one([
      for r in aws_s3_bucket_server_side_encryption_configuration.state.rule :
      one(r.apply_server_side_encryption_by_default).sse_algorithm
    ]) == "aws:kms"
    error_message = "State bucket must use aws:kms SSE."
  }

  assert {
    condition = one([
      for r in aws_s3_bucket_server_side_encryption_configuration.state.rule :
      one(r.apply_server_side_encryption_by_default).kms_master_key_id
    ]) == aws_kms_key.state.arn
    error_message = "State bucket SSE must use the dedicated state KMS key."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "All four public-access-block settings must be on for the state bucket."
  }

  assert {
    condition = one([
      for r in aws_s3_bucket_lifecycle_configuration.state.rule :
      one(r.noncurrent_version_expiration).noncurrent_days if r.status == "Enabled"
    ]) == 90
    error_message = "Noncurrent state versions must expire after 90 days."
  }

  assert {
    condition     = aws_kms_key.state.enable_key_rotation
    error_message = "State KMS key must rotate."
  }

  assert {
    condition     = aws_kms_alias.state.name == "alias/blackwing-tfstate"
    error_message = "KMS alias must match backend.tf."
  }
}

run "state_bucket_policy_restricts_access" {
  command = plan

  assert {
    condition = contains(
      [for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Sid],
      "DenyEveryoneButOpsRoles",
    )
    error_message = "Bucket policy must deny every principal except the ops roles."
  }

  assert {
    condition = one([
      for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement :
      s.Condition.ArnNotLike["aws:PrincipalArn"] if s.Sid == "DenyEveryoneButOpsRoles"
    ]) == var.state_admin_principal_arns
    error_message = "The ops-role restriction must use state_admin_principal_arns."
  }

  assert {
    condition = contains(
      [for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Sid],
      "DenyInsecureTransport",
    )
    error_message = "Bucket policy must deny non-TLS access."
  }
}

run "access_logging_and_audit_trail" {
  command = plan

  assert {
    condition     = aws_s3_bucket_logging.state.target_bucket == aws_s3_bucket.logs.id
    error_message = "State bucket server access logs must go to the log bucket."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.logs.block_public_acls,
      aws_s3_bucket_public_access_block.logs.block_public_policy,
      aws_s3_bucket_public_access_block.logs.ignore_public_acls,
      aws_s3_bucket_public_access_block.logs.restrict_public_buckets,
    ])
    error_message = "The log bucket must block public access."
  }

  assert {
    condition     = aws_cloudtrail.state_access.enable_log_file_validation
    error_message = "CloudTrail log file validation must be on (tamper evidence)."
  }

  assert {
    condition = contains(flatten([
      for sel in aws_cloudtrail.state_access.advanced_event_selector : [
        for f in sel.field_selector : f.starts_with if f.field == "resources.ARN"
      ]
    ]), "${aws_s3_bucket.state.arn}/")
    error_message = "CloudTrail must record data events for the state bucket's objects."
  }
}

run "lock_table_shape" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.lock.name == "blackwing-tfstate-lock"
    error_message = "Lock table name must match backend.tf."
  }

  assert {
    condition     = aws_dynamodb_table.lock.hash_key == "LockID"
    error_message = "Lock table hash key must be LockID."
  }

  assert {
    condition     = one([for a in aws_dynamodb_table.lock.attribute : a.type if a.name == "LockID"]) == "S"
    error_message = "LockID must be a string attribute."
  }

  assert {
    condition     = aws_dynamodb_table.lock.billing_mode == "PAY_PER_REQUEST"
    error_message = "Lock table must be PAY_PER_REQUEST."
  }

  assert {
    condition     = aws_dynamodb_table.lock.deletion_protection_enabled
    error_message = "Lock table must have deletion protection."
  }
}

# Re-running bootstrap is idempotent: every stateful identity is derived only from the inputs
# (no name_prefix, no random suffix), so a second run against the same state resolves to the same
# bucket, table and key and has nothing to create. scripts/check.sh additionally asserts that the
# bucket, log bucket, lock table and KMS key carry prevent_destroy, so any plan that would replace
# them is refused instead of recreating them.
run "reapply_does_not_recreate" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "blackwing-tfstate-123456789012-eu-central-1"
    error_message = "State bucket name must be derived only from account and region."
  }

  assert {
    condition     = aws_s3_bucket.logs.bucket == "blackwing-tfstate-logs-123456789012-eu-central-1"
    error_message = "Log bucket name must be derived only from account and region."
  }

  assert {
    condition     = aws_dynamodb_table.lock.name == "blackwing-tfstate-lock"
    error_message = "Lock table name must be fixed."
  }

  assert {
    condition     = aws_kms_alias.state.name == "alias/blackwing-tfstate"
    error_message = "KMS alias must be fixed so the key is found again, not recreated."
  }

  assert {
    condition     = coalesce(aws_s3_bucket.state.force_destroy, false) == false
    error_message = "State bucket must never be force-destroyed."
  }
}

run "common_tags_on_every_resource" {
  command = plan

  assert {
    condition = (
      output.common_tags.Project == "blackwing" &&
      output.common_tags.Environment == "dev" &&
      output.common_tags.ManagedBy == "opentofu" &&
      length(output.common_tags) == 3
    )
    error_message = "Bootstrap must apply the common_tags convention via default_tags."
  }
}

run "rejects_empty_admin_principals" {
  command = plan

  variables {
    state_admin_principal_arns = []
  }

  expect_failures = [var.state_admin_principal_arns]
}

run "rejects_wrong_environment" {
  command = plan

  variables {
    environment = "production"
  }

  expect_failures = [var.environment]
}

run "rejects_short_noncurrent_retention" {
  command = plan

  variables {
    noncurrent_version_expiration_days = 1
  }

  expect_failures = [var.noncurrent_version_expiration_days]
}
