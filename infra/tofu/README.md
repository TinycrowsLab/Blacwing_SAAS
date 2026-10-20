# infra/tofu: OpenTofu for Blackwing on AWS

All AWS infrastructure is code here (CONTEXT_PACK §5 "no click-ops"). INFRA-001 (#36) set up the
layout, toolchain pins, tagging and the remote state backend. Resources arrive with INFRA-002 and
later issues as modules.

```
infra/tofu/
  .opentofu-version        exact OpenTofu version (read by tenv/tofuenv; check.sh enforces it)
  versions.tf              required_version + hashicorp/aws "~>" pin          (shared, symlinked)
  providers.tf             aws provider, allowed_account_ids, default_tags    (shared, symlinked)
  backend.tf               S3 backend + DynamoDB lock, per-env key            (shared, symlinked)
  common_variables.tf      environment / aws_region / aws_account_id inputs   (shared, symlinked)
  .tflint.hcl              tflint config (bundled terraform ruleset, offline)
  bootstrap/               one-time state bucket, log bucket, KMS key, lock table, CloudTrail
  environments/{dev,staging,prod}/
                           main.tf, variables.tf, terraform.tfvars, outputs.tf, .terraform.lock.hcl
  modules/                 reusable modules (see modules/README.md): vpc (INFRA-002)
  scripts/check.sh         offline fmt/validate/tflint/test for every root
  tests/                   shared tofu tests and the backend-lock integration test
```

Shared files are symlinks so the roots cannot drift. Never copy them into a root.
`node scripts/check-tofu.mjs` (part of `pnpm test:scripts`) enforces the layout and the rules below.

## Conventions

- **Tags.** `locals.common_tags = { Project = "blackwing", Environment = var.environment, ManagedBy = "opentofu" }`
  is applied to every resource through the provider's `default_tags`. Modules never repeat these keys
  and never declare their own `provider "aws"`.
- **No hardcoded account IDs.** `aws_account_id` comes from `TF_VAR_aws_account_id`. The provider's
  `allowed_account_ids` stops a run against the wrong account before it plans anything.
- **Environment guard.** `environment` is validated against `dev`, `staging` and `prod`. Each
  `terraform.tfvars` sets its own directory's environment (checked by `check-tofu.mjs`).
- **Change review.** `tofu plan` output is the change-review artifact. Paste or attach it in the PR
  for every infrastructure change. Never apply a change that has not been reviewed as a plan.
- **No state in git.** `*.tfstate`, `*.tfplan`, `.terraform/` and `*_override.tf` are gitignored.

## Prerequisites

| What | Value |
|---|---|
| OpenTofu | the exact version in `.opentofu-version` (for example `tenv tofu install`) |
| `AWS_PROFILE` | a profile, or SSO session, that can assume the ops role of the target account |
| `AWS_REGION` | the environment's region. It must equal `aws_region` in `terraform.tfvars` |
| `TF_VAR_aws_account_id` | the 12-digit account ID of the target account |

**Missing credentials or region fail fast.** With no `aws_region` (or a malformed one), the
variable validation stops the run with a clear message. With no usable credentials, the AWS
provider stops at the first plan with `No valid credential sources found`. With the wrong account,
`allowed_account_ids` stops it with `AWS account ID not allowed`. Nothing is changed in any of these
cases.

## Bootstrap (once per account and region)

The state bucket must exist before any root can keep its state in it. That includes bootstrap
itself. Break the cycle like this:

1. Create a local backend override. It is gitignored and must never be committed:
   ```sh
   cd infra/tofu/bootstrap
   printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf
   cp terraform.tfvars.example terraform.tfvars   # set environment, aws_region, state_admin_principal_arns
   export TF_VAR_aws_account_id=<12-digit account id>
   ```
   `state_admin_principal_arns` must include the ops role and the role you are running as. The
   bucket policy denies everyone else, so leaving out your own role locks you out (only the account
   root user can repair the policy).
2. Apply on local state and review the plan first:
   ```sh
   tofu init
   tofu plan -out=bootstrap.tfplan
   tofu apply bootstrap.tfplan
   ```
3. Move the state into the bucket you just created:
   ```sh
   rm backend_override.tf
   tofu init -migrate-state      # answer "yes"; state goes to blackwing/bootstrap/<region>/terraform.tfstate
   rm -f terraform.tfstate terraform.tfstate.backup bootstrap.tfplan
   ```

Re-running bootstrap later (`tofu init && tofu plan`) uses the migrated state and plans no
changes. The bucket, lock table and KMS key have `prevent_destroy`, and the lock table also has
deletion protection, so a re-run can never recreate or delete them.

What bootstrap creates:

| Resource | Settings |
|---|---|
| `blackwing-tfstate-<account>-<region>` (S3) | versioning on; SSE `aws:kms` with the state CMK (bucket key on); all four public-access-block flags; `BucketOwnerEnforced`; noncurrent versions expire after 90 days; TLS-only; writes without SSE-KMS denied; access limited to `state_admin_principal_arns`; server access logs to the log bucket; **no Object Lock** (it would block state overwrites; Object Lock is for evidence buckets, INFRA-006) |
| `blackwing-tfstate-logs-<account>-<region>` (S3) | server access logs (`s3-access/`) and CloudTrail files (`cloudtrail/`); SSE-S3 (log delivery does not support KMS); public access blocked; expires after `access_log_retention_days` (365) |
| `alias/blackwing-tfstate` (KMS) | rotation on, 30-day deletion window |
| `blackwing-tfstate-lock` (DynamoDB) | hash key `LockID` (S), `PAY_PER_REQUEST`, KMS-encrypted, point-in-time recovery, deletion protection |
| `blackwing-tfstate-access` (CloudTrail) | object-level data events for the state bucket, log file validation on (audit of state access) |

## Working with an environment

```sh
export AWS_PROFILE=blackwing-dev AWS_REGION=eu-central-1 TF_VAR_aws_account_id=<id>
tofu -chdir=infra/tofu/environments/dev init       # S3 backend, key blackwing/dev/terraform.tfstate
tofu -chdir=infra/tofu/environments/dev plan -out=dev.tfplan
tofu -chdir=infra/tofu/environments/dev apply dev.tfplan
```

Use the same commands with `staging` or `prod`. Each environment directory reads only its own
`terraform.tfvars`, and the backend key is derived from `var.environment`. Running in the wrong
directory with the wrong variables therefore fails validation instead of touching another
environment's state.

**Locking.** Every `plan` and `apply` takes a lock item in `blackwing-tfstate-lock`. A second
concurrent run fails with `Error acquiring the state lock` (or waits with `-lock-timeout=5m`). It
never writes state underneath the first one.

**Lock held after a crash.** When a run is killed, its lock stays behind and every later run fails
with `Error acquiring the state lock`, which prints the lock `ID`. To release it:

```sh
tofu -chdir=infra/tofu/environments/dev force-unlock <ID>
```

> **Warning:** only force-unlock after confirming that no other `plan` or `apply` is running for that
> environment (check CI and ask the team). Unlocking under a live run lets two writers overwrite each
> other's state. If state was damaged, restore the previous object version from the versioned bucket.

**Drift.** Manual console changes ("click-ops") are not allowed. Because every attribute is in code,
`tofu plan` shows any manual change as drift (`~ update in-place` or `Objects have changed outside of
OpenTofu`). Revert the console change, or bring it into code through a reviewed PR.

**Provider lock files.** `.terraform.lock.hcl` is committed per root. After changing a provider pin, run
`tofu init -upgrade` and `tofu providers lock -platform=linux_amd64 -platform=darwin_arm64` and commit the
result.

## Tests (offline)

```sh
infra/tofu/scripts/check.sh            # fmt -check, init -backend=false, validate, tflint, tofu test (mocked AWS)
infra/tofu/tests/backend-lock/run.sh   # S3 backend + DynamoDB locking on MinIO + DynamoDB Local (docker)
node scripts/check-tofu.mjs            # static layout/policy checks (also in pnpm test:scripts)
```

- `tofu test` with a mocked AWS provider covers: the bootstrap bucket settings, the lock table, no
  Object Lock, access logging and CloudTrail, an idempotent re-apply, `common_tags`, and rejection of
  an invalid environment, region, account ID, empty admin list and too-short retention.
- `backend-lock/run.sh` runs `tofu -chdir=environments/dev init` against the S3 backend, races two
  applies (the second fails on the DynamoDB lock and state stays intact), and recovers a crashed
  run's lock with `force-unlock`, checks that a plan without AWS credentials stops at once with
  `No valid credential sources found`, and shows that an out-of-band change (versioning suspended
  behind the config's back) appears as drift in `tofu plan -detailed-exitcode` (exit 2).
- `scripts/check-tofu.mjs` (node, no tofu needed) enforces the version pins, the environment layout
  and symlinks, the backend settings, `default_tags`, no hardcoded account IDs or committed state,
  no Object Lock on the state bucket and `prevent_destroy` on every stateful bootstrap resource.
- Real-AWS verification (bootstrap apply, AWS CLI checks of the bucket, locking against the real
  table, drift) is tracked in #872. Nothing in this repo applies to AWS automatically.
