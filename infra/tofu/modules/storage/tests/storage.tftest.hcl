# Offline policy tests for the storage module (INFRA-006). The AWS provider is mocked, nothing
# here talks to AWS. Policies are asserted from the planned JSON documents.

mock_provider "aws" {
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:eu-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::mock-bucket"
    }
  }
}

variables {
  environment       = "dev"
  aws_account_id    = "123456789012"
  app_role_arn      = "arn:aws:iam::123456789012:role/blackwing-dev-app"
  access_log_bucket = "blackwing-tfstate-logs-123456789012-eu-central-1"
}

run "four_buckets_named_by_purpose" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket.this["evidence"].bucket == "bw-dev-evidence" &&
      aws_s3_bucket.this["exports"].bucket == "bw-dev-exports" &&
      aws_s3_bucket.this["backups"].bucket == "bw-dev-backups" &&
      aws_s3_bucket.this["transcripts"].bucket == "bw-dev-transcripts"
    )
    error_message = "Buckets must be bw-<env>-{evidence,exports,backups,transcripts}."
  }
}

run "object_lock_only_on_evidence_set_at_creation" {
  command = plan

  assert {
    condition     = aws_s3_bucket.this["evidence"].object_lock_enabled == true
    error_message = "The evidence bucket must be created with Object Lock enabled (it cannot be enabled later)."
  }

  assert {
    condition = (
      aws_s3_bucket.this["exports"].object_lock_enabled == false &&
      aws_s3_bucket.this["backups"].object_lock_enabled == false &&
      aws_s3_bucket.this["transcripts"].object_lock_enabled == false
    )
    error_message = "Only the evidence bucket has Object Lock."
  }

  assert {
    condition = (
      aws_s3_bucket_object_lock_configuration.evidence.rule[0].default_retention[0].mode == "COMPLIANCE" &&
      aws_s3_bucket_object_lock_configuration.evidence.rule[0].default_retention[0].days == 30
    )
    error_message = "Evidence default retention must be COMPLIANCE for evidence_retention_days (30 by default)."
  }
}

run "retention_days_variable_is_honoured" {
  command = plan

  variables {
    evidence_retention_days = 90
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.evidence.rule[0].default_retention[0].days == 90
    error_message = "evidence_retention_days must drive the default retention."
  }
}

run "buckets_are_versioned_encrypted_and_private" {
  command = plan

  assert {
    condition     = alltrue([for k, v in aws_s3_bucket_versioning.this : v.versioning_configuration[0].status == "Enabled"])
    error_message = "All four buckets must be versioned."
  }

  assert {
    condition = alltrue([
      for k, v in aws_s3_bucket_public_access_block.this :
      v.block_public_acls && v.block_public_policy && v.ignore_public_acls && v.restrict_public_buckets
    ]) && length(aws_s3_bucket_public_access_block.this) == 4
    error_message = "Public access must be fully blocked on all four buckets."
  }

  assert {
    condition = alltrue([
      for k, v in aws_s3_bucket_server_side_encryption_configuration.this :
      one(one(v.rule).apply_server_side_encryption_by_default).sse_algorithm == "aws:kms"
    ]) && length(aws_s3_bucket_server_side_encryption_configuration.this) == 4
    error_message = "All four buckets must use SSE-KMS."
  }
}

run "one_rotating_cmk_per_bucket" {
  command = plan

  assert {
    condition     = length(aws_kms_key.this) == 4 && alltrue([for k, v in aws_kms_key.this : v.enable_key_rotation])
    error_message = "Need one CMK per bucket with rotation enabled."
  }
}

run "kms_policy_requires_tenant_encryption_context" {
  command = plan

  assert {
    condition = alltrue([
      for k, v in aws_kms_key.this : (
        length([
          for s in jsondecode(v.policy).Statement : s
          if s.Sid == "AppRoleCryptoWithTenantContext" &&
          s.Effect == "Allow" &&
          try(s.Principal.AWS, "") == "arn:aws:iam::123456789012:role/blackwing-dev-app" &&
          contains(try(tolist(s.Action), [s.Action]), "kms:Encrypt") && contains(try(tolist(s.Action), [s.Action]), "kms:Decrypt") && contains(try(tolist(s.Action), [s.Action]), "kms:GenerateDataKey") &&
          try(s.Condition.Null["kms:EncryptionContext:tenantId"], "") == "false"
        ]) == 1
      )
    ])
    error_message = "The app role may use the key only when the tenantId encryption context is present."
  }

  assert {
    condition = alltrue([
      for k, v in aws_kms_key.this : (
        length([
          for s in jsondecode(v.policy).Statement : s
          if s.Sid == "DenyCryptoWithoutTenantContext" && s.Effect == "Deny" &&
          try(s.Condition.Null["kms:EncryptionContext:tenantId"], "") == "true"
        ]) == 1
      )
    ])
    error_message = "A PUT without the tenantId encryption context must be denied by the key policy."
  }

  assert {
    condition = alltrue([
      for k, v in aws_kms_key.this : alltrue([
        for s in jsondecode(v.policy).Statement :
        !contains([for a in(try(tolist(s.Action), [s.Action])) : a], "kms:*") && s.Sid != "AccountRootAllCrypto"
      ])
    ])
    error_message = "No statement may grant kms:* (it would let IAM policies bypass the tenantId condition)."
  }
}

run "bucket_policy_denies_non_tls_and_unencrypted_put" {
  command = plan

  assert {
    condition = alltrue([
      for k, v in aws_s3_bucket_policy.this : length([
        for s in jsondecode(v.policy).Statement : s
        if s.Sid == "DenyInsecureTransport" && s.Effect == "Deny" && s.Action == "s3:*" &&
        try(s.Condition.Bool["aws:SecureTransport"], "") == "false"
      ]) == 1
    ])
    error_message = "Every bucket must deny s3:* when aws:SecureTransport is false."
  }

  assert {
    condition = alltrue([
      for k, v in aws_s3_bucket_policy.this : length([
        for s in jsondecode(v.policy).Statement : s
        if s.Sid == "DenyUnencryptedPut" && s.Effect == "Deny" && s.Action == "s3:PutObject" &&
        try(s.Condition.StringNotEquals["s3:x-amz-server-side-encryption"], "") == "aws:kms"
      ]) == 1
    ])
    error_message = "Every bucket must deny PutObject unless x-amz-server-side-encryption is aws:kms."
  }
}

run "tenant_prefix_enforced_where_applicable" {
  command = plan

  assert {
    condition = alltrue([
      for k in ["evidence", "exports", "transcripts"] : length([
        for s in jsondecode(aws_s3_bucket_policy.this[k].policy).Statement : s
        if s.Sid == "DenyKeysOutsideTenantPrefix"
      ]) == 1
    ])
    error_message = "Evidence, exports and transcripts must only accept keys under t/<tenantId>/."
  }

  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.this["backups"].policy).Statement : s
      if s.Sid == "DenyKeysOutsideTenantPrefix"
    ]) == 0
    error_message = "Backups are not tenant-prefixed."
  }
}

run "evidence_policy_blocks_lock_weakening" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.this["evidence"].policy).Statement : s
      if s.Sid == "DenyObjectLockWeakening" && contains(try(tolist(s.Action), [s.Action]), "s3:BypassGovernanceRetention")
    ]) == 1
    error_message = "The evidence bucket policy must deny bypassing or reconfiguring Object Lock."
  }
}

run "evidence_lifecycle_never_expires_current_versions" {
  command = plan

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_lifecycle_configuration.this["evidence"].rule : one(r.expiration) == null
    ])
    error_message = "Evidence lifecycle must not expire current versions (retention_until is owned by the app)."
  }

  assert {
    condition     = one(one(aws_s3_bucket_lifecycle_configuration.this["evidence"].rule).noncurrent_version_expiration).noncurrent_days > 30
    error_message = "Evidence noncurrent expiry must exceed the Object Lock retention."
  }

  assert {
    condition = (
      one(one(aws_s3_bucket_lifecycle_configuration.this["exports"].rule).expiration).days == 90 &&
      one(one(aws_s3_bucket_lifecycle_configuration.this["transcripts"].rule).expiration).days == 180
    )
    error_message = "Exports and transcripts expire per their retention variables."
  }
}

run "rejects_noncurrent_expiry_not_exceeding_retention" {
  command = plan

  variables {
    evidence_retention_days             = 400
    evidence_noncurrent_expiration_days = 365
  }

  expect_failures = [aws_s3_bucket_object_lock_configuration.evidence]
}

run "rejects_zero_retention" {
  command = plan

  variables {
    evidence_retention_days = 0
  }

  expect_failures = [var.evidence_retention_days]
}

run "rejects_non_role_app_arn" {
  command = plan

  variables {
    app_role_arn = "arn:aws:iam::123456789012:user/bob"
  }

  expect_failures = [var.app_role_arn]
}

run "access_logging_and_denied_request_alarm_on_every_bucket" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_logging.this) == 4 && length(aws_cloudwatch_metric_alarm.denied_requests) == 4
    error_message = "All four buckets need access logging and a 4xx alarm."
  }

  assert {
    condition     = alltrue([for k, v in aws_s3_bucket_logging.this : startswith(v.target_prefix, "s3-access/")])
    error_message = "Access logs must go under s3-access/, the only prefix the bootstrap log bucket accepts."
  }
}

run "outputs_expose_names_and_cmk_arns" {
  command = plan

  assert {
    condition     = length(output.bucket_names) == 4 && length(output.kms_key_arns) == 4 && output.encryption_context_key == "tenantId"
    error_message = "Outputs must expose four bucket names, four CMK ARNs and the encryption context key."
  }
}
