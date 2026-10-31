# Storage buckets (INFRA-006)

Module: `infra/tofu/modules/storage`, called from every environment root (`environments/<env>/storage.tf`).

| Bucket | Purpose | Object Lock | Key prefix | Expiry variable |
|---|---|---|---|---|
| `bw-<env>-evidence` | Evidence artefacts (screenshots, HTTP traces, repro artefacts) | COMPLIANCE, default `evidence_retention_days` (30) | `t/<tenantId>/` | none for current versions |
| `bw-<env>-exports` | Reports and exports | no | `t/<tenantId>/` | `exports_retention_days` (90) |
| `bw-<env>-backups` | Database and config backups (INFRA-013/014 fill it) | no | free | `backups_retention_days` (35) |
| `bw-<env>-transcripts` | Agent transcripts | no | `t/<tenantId>/` | `transcripts_retention_days` (180) |

Outputs for Helm values and app config: `bucket_names`, `bucket_arns`, `kms_key_arns`, `kms_key_aliases`,
`tenant_prefix_template`, `encryption_context_key`. Environment roots re-export `storage_bucket_names` and
`storage_kms_key_arns`.

## Controls on every bucket

- Versioning on, SSE-KMS with its own customer-managed key (rotation on), public access fully blocked,
  `BucketOwnerEnforced`.
- Bucket policy: deny `s3:*` when `aws:SecureTransport=false`; deny `PutObject` unless
  `s3:x-amz-server-side-encryption=aws:kms` and the key is the bucket's own CMK.
- Evidence, exports and transcripts also deny `PutObject` outside `t/*`. No PII in keys: use IDs only.
- S3 server access logs go to the bootstrap log bucket under `s3-access/<bucket>/` (its policy accepts delivery from `bw-*` buckets of the account). S3 data events for all four buckets go
  to a CloudTrail Lake event data store (`<prefix>-s3-data-events`, termination protection on). A CloudWatch alarm per
  bucket fires on 4xx (including 403) requests.

## Object Lock (evidence)

- Enabled **at bucket creation** (`object_lock_enabled = true`). It cannot be enabled later and cannot be disabled.
  A bucket that exists without it must be recreated, which `prevent_destroy` refuses on purpose. The tofu test
  `object_lock_only_on_evidence_set_at_creation` guards this.
- Default retention is **COMPLIANCE** mode: nobody, including the account root, can shorten it or delete a locked
  version. The bucket policy additionally denies `s3:BypassGovernanceRetention` and
  `s3:PutBucketObjectLockConfiguration`.
- **Retention is enforced by S3 server time**, not by client clocks. A skewed client clock cannot shorten or extend it.
  The app records `retention_until` (§7) from the server's response, not from its own clock.
- **Legal hold** is per object version (`PutObjectLegalHold`, set by the app from `evidence_items.legal_hold`).
  A held version stays undeletable after its retention date passes, until the hold is removed.
- Lifecycle never expires current evidence versions (the RETAIN epic deletes after `retention_until`). Non-current
  versions expire after `evidence_noncurrent_expiration_days`, which must exceed the retention (precondition);
  S3 refuses to delete a still-locked or held version either way.
- The OpenTofu state bucket (bootstrap) is separate and never has Object Lock.

## Application writes (EVIDENCE-002, `@blackwing/evidence`)

- `createEvidenceStore` is the only writer of evidence bytes. It checks `GetObjectLockConfiguration` at startup and
  refuses to start when the bucket has no Object Lock (fail closed, §8.8).
- Keys are `t/<tenantId>/runs/<runId>/<kind>/<uuidv7>`. The `t/` prefix is the one the bucket policy above allows, so a
  different prefix would be denied on AWS. Reads and deletes refuse any key outside the caller's tenant before S3 is
  called.
- Each write sends SSE-KMS with the bucket key (`EVIDENCE_KMS_KEY_ID`) and the context `{"tenantId":"<id>"}`. A write
  first asks the tenant key service (OpenBao) for the tenant key, so an unreachable or disabled key stops the write.
- Retention is COMPLIANCE, floored at `EVIDENCE_DEFAULT_RETENTION_DAYS`. The retain-until recorded is the value S3
  returns for the version. `delete` refuses while retention runs or a legal hold is on.
- Config keys: `EVIDENCE_BUCKET`, `EVIDENCE_OBJECT_LOCK_MODE` (default `COMPLIANCE`), `EVIDENCE_DEFAULT_RETENTION_DAYS`
  (default 365), `EVIDENCE_SSE` (`aws:kms` or `minio`), `EVIDENCE_KMS_KEY_ID`. The schema is `evidenceStoreEnvSchema`
  in `@blackwing/config`.
- Dev and test: MinIO with object locking, and a static MinIO KMS key for SSE-KMS (`MINIO_KMS_SECRET_KEY`). The
  integration test is `packages/evidence/src/store.int.test.ts` (`pnpm --filter @blackwing/evidence test:int`).

## Tenant isolation (§8 #6)

Every KMS key policy:

1. Lets the account administer the key (no data-plane crypto actions, so IAM policies cannot bypass the condition).
2. Lets only the app role call `Encrypt`, `Decrypt`, `GenerateDataKey*` and only when the
   `kms:EncryptionContext:tenantId` key is present.
3. Denies everyone `Encrypt`, `Decrypt`, `ReEncrypt*` and `GenerateDataKey*` when the context is absent.

The app must send `x-amz-server-side-encryption-context` (base64 JSON `{"tenantId":"<id>"}`) on every PUT, and the
same context on envelope `GenerateDataKey`/`Decrypt` calls. This is **defence in depth**: the primary control is
the app layer (RLS, authz, `t/<tenantId>/` keys). A cross-tenant read through the wrong prefix is stopped by the
app, and the context binds each object's ciphertext to its tenant.

**KMS throttling.** S3 Bucket Keys are not enabled: with a bucket key S3 uses the bucket ARN as the only encryption
context, so the `tenantId` condition could not hold. For bulk writes the app uses data keys (`GenerateDataKey`,
envelope encryption, one data key per batch) to keep KMS call volume down.

## Verification

- `tofu test` in `infra/tofu/modules/storage` (offline, mocked AWS): Object Lock set at creation, COMPLIANCE and
  retention, public access block, SSE-KMS, rotation, TLS-only, unencrypted-PUT deny, tenantId key policy,
  lifecycle rules, variable validation.
- `infra/tofu/tests/object-lock/run.sh` (MinIO, offline): locked versions cannot be deleted or overwritten away,
  legal hold outlives retention. The TLS, SSE-KMS-header and KMS-context assertions need real AWS and are tracked in
  the online-porting issue for the storage buckets.
