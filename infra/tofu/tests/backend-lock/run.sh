#!/usr/bin/env bash
# Integration test for the S3 backend + DynamoDB locking (INFRA-001), run fully offline.
#
# OFFLINE-STUB(online-porting #872): MinIO and DynamoDB Local stand in for AWS S3 and
# DynamoDB. The same assertions must be repeated against the real dev backend in AWS.
#
# Starts MinIO (S3 API, SSE-KMS with a static key) and DynamoDB Local on random loopback ports,
# seeds the bucket and lock table, then proves:
#   1. `tofu -chdir=infra/tofu/environments/dev init` succeeds against the S3 backend with
#      DynamoDB locking (the committed backend.tf, only endpoints overridden);
#   2. two concurrent applies: the second fails with "Error acquiring the state lock" and the
#      state afterwards is the first apply's, intact (no corruption); a later apply succeeds;
#   3. a lock left behind by a crashed (SIGKILLed) apply blocks others until
#      `tofu force-unlock` releases it, after which applies work again.
# Containers are removed on exit. Requires docker and the pinned tofu.
set -euo pipefail

TOFU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$TOFU_DIR/tests/backend-lock"
TOFU="${TOFU:-tofu}"

# Pinned by digest (same MinIO reference as packages/testing TEST_IMAGES.minio).
MINIO_IMAGE='cgr.dev/chainguard/minio:latest@sha256:cff197fef764642223ef9f4444c903d51aee9b544a7be8bc007fef6b7b00d136'
DYNAMODB_IMAGE='amazon/dynamodb-local:2.5.2@sha256:d7ebddeb60fa418bcda218a6c6a402a58441b2a20d54c9cb1d85fd5194341753'

ACCOUNT_ID='111111111111' # fake account for the local backend only
REGION='eu-central-1'
BUCKET="blackwing-tfstate-${ACCOUNT_ID}-${REGION}"
# MinIO's static KMS key; named as a KMS key ID because the s3 backend validates kms_key_id.
KMS_KEY='5f1a4c2e-0b7d-4e8a-9c3f-2d6b8e1a7c40'

WORK="$(mktemp -d)"
LABEL="blackwing.test=tofu-backend-lock-$$"
containers=()
bg_pids=()

cleanup() {
  local pid
  for pid in "${bg_pids[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
  if [[ ${#containers[@]} -gt 0 ]]; then docker rm -f "${containers[@]}" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
  # A killed apply may leave errored.tfstate next to the probe config; never keep it.
  rm -f "$HERE/probe/errored.tfstate"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

rand() { head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c "$1"; }

export TF_IN_AUTOMATION=1
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.cache/blackwing/tofu-plugins}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"
AWS_ACCESS_KEY_ID="bwtest$(rand 10)"
AWS_SECRET_ACCESS_KEY="$(rand 32)"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export AWS_REGION="$REGION"
unset AWS_PROFILE AWS_SESSION_TOKEN

echo "==> starting MinIO and DynamoDB Local"
containers+=("$(docker run -d --rm --label "$LABEL" -p 127.0.0.1::9000 \
  -e MINIO_ROOT_USER="$AWS_ACCESS_KEY_ID" -e MINIO_ROOT_PASSWORD="$AWS_SECRET_ACCESS_KEY" \
  -e MINIO_KMS_SECRET_KEY="${KMS_KEY}:$(head -c 32 /dev/urandom | base64)" \
  "$MINIO_IMAGE" server /data --address :9000)")
containers+=("$(docker run -d --rm --label "$LABEL" -p 127.0.0.1::8000 \
  "$DYNAMODB_IMAGE" -jar DynamoDBLocal.jar -inMemory -sharedDb)")

port_of() { docker port "$1" "$2/tcp" | head -n1 | sed 's/.*://'; }
S3_ENDPOINT="http://127.0.0.1:$(port_of "${containers[0]}" 9000)"
DDB_ENDPOINT="http://127.0.0.1:$(port_of "${containers[1]}" 8000)"

for _ in $(seq 1 60); do
  if curl -fsS "$S3_ENDPOINT/minio/health/ready" >/dev/null 2>&1 &&
    curl -sS -o /dev/null "$DDB_ENDPOINT" 2>/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS "$S3_ENDPOINT/minio/health/ready" >/dev/null || fail "MinIO did not become ready"

echo "==> seeding bucket $BUCKET and lock table"
export TF_DATA_DIR="$WORK/seed"
"$TOFU" -chdir="$HERE/seed" init -input=false -no-color >"$WORK/seed-init.log" 2>&1 || {
  cat "$WORK/seed-init.log" >&2
  fail "seed init"
}
"$TOFU" -chdir="$HERE/seed" apply -input=false -no-color -auto-approve -state="$WORK/seed.tfstate" \
  -var "s3_endpoint=$S3_ENDPOINT" -var "dynamodb_endpoint=$DDB_ENDPOINT" -var "bucket=$BUCKET" \
  >"$WORK/seed-apply.log" 2>&1 || {
  cat "$WORK/seed-apply.log" >&2
  fail "seed apply"
}

# Only the endpoints, path-style addressing, the local KMS key name and the AWS-account lookups
# are overridden; bucket, key, region, dynamodb_table and encrypt come from the committed backend.tf.
cat >"$WORK/local.s3.tfbackend" <<EOF
endpoints = {
  s3       = "$S3_ENDPOINT"
  dynamodb = "$DDB_ENDPOINT"
}
use_path_style              = true
skip_credentials_validation = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_region_validation      = true
kms_key_id                  = "$KMS_KEY"
EOF

export TF_VAR_aws_account_id="$ACCOUNT_ID"

# --- 1. init of the dev environment against the S3 backend with DynamoDB locking -------------------
echo "==> 1. tofu -chdir=environments/dev init"
export TF_DATA_DIR="$WORK/dev"
"$TOFU" -chdir="$TOFU_DIR/environments/dev" init -input=false -no-color -lockfile=readonly \
  -backend-config="$WORK/local.s3.tfbackend" >"$WORK/dev-init.log" 2>&1 || {
  cat "$WORK/dev-init.log" >&2
  fail "dev init against the S3 backend"
}
grep -q 'Successfully configured the backend "s3"' "$WORK/dev-init.log" || fail "dev init did not configure the s3 backend"
"$TOFU" -chdir="$TOFU_DIR/environments/dev" state pull >/dev/null || fail "state pull through the backend"
pass "environments/dev init succeeds against the S3 backend (key blackwing/dev/terraform.tfstate, DynamoDB lock table)"

# --- 2. concurrent applies -------------------------------------------------------------------------
probe() { "$TOFU" -chdir="$HERE/probe" "$@"; }
export TF_DATA_DIR="$WORK/probe"
export TF_VAR_environment=dev TF_VAR_aws_region="$REGION"
probe init -input=false -no-color -backend-config="$WORK/local.s3.tfbackend" >"$WORK/probe-init.log" 2>&1 || {
  cat "$WORK/probe-init.log" >&2
  fail "probe init"
}

wait_for() { # file pattern seconds
  local _
  for _ in $(seq 1 "$3"); do
    grep -q "$2" "$1" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# The first apply holds the lock for 90 s, so a loaded host cannot let it lapse before the
# second apply reaches the lock.
echo "==> 2. two concurrent applies"
probe apply -input=false -no-color -auto-approve -var run_id=first -var hold_seconds=90 >"$WORK/a.log" 2>&1 &
pid_a=$!
bg_pids+=("$pid_a")
wait_for "$WORK/a.log" 'terraform_data.hold: Creating' 240 || {
  cat "$WORK/a.log" >&2
  fail "first apply never started"
}
if probe apply -input=false -no-color -auto-approve -lock-timeout=0s -var run_id=second >"$WORK/b.log" 2>&1; then
  fail "second concurrent apply was not blocked by the lock"
fi
grep -q 'Error acquiring the state lock' "$WORK/b.log" || {
  cat "$WORK/b.log" >&2
  fail "second apply failed for a reason other than the lock"
}
grep -q 'ConditionalCheckFailedException' "$WORK/b.log" || fail "lock error did not come from the DynamoDB conditional write"
wait "$pid_a" || {
  cat "$WORK/a.log" >&2
  fail "first apply did not complete"
}
[[ "$(probe output -raw run_id)" == "first" ]] || fail "state after the race is not the first apply's"
probe state pull >"$WORK/state.json"
grep -q '"serial"' "$WORK/state.json" || fail "state pulled after the race is not a valid state file"
probe apply -input=false -no-color -auto-approve -var run_id=second >"$WORK/b2.log" 2>&1 || {
  cat "$WORK/b2.log" >&2
  fail "apply after the lock was released"
}
[[ "$(probe output -raw run_id)" == "second" ]] || fail "later apply did not update state"
pass "second concurrent apply blocked on the DynamoDB lock; state intact; later apply succeeds"

# --- 3. lock left by a crashed apply -------------------------------------------------------------
echo "==> 3. stale lock after a crash, released with force-unlock"
probe apply -input=false -no-color -auto-approve -var run_id=crashed -var hold_seconds=300 >"$WORK/c.log" 2>&1 &
pid_c=$!
bg_pids+=("$pid_c")
wait_for "$WORK/c.log" 'terraform_data.hold: Creating' 240 || fail "crash-test apply never started"
pkill -9 -P "$pid_c" 2>/dev/null || true
kill -9 "$pid_c" 2>/dev/null || true
wait "$pid_c" 2>/dev/null || true
if probe apply -input=false -no-color -auto-approve -lock-timeout=0s -var run_id=after-crash >"$WORK/d.log" 2>&1; then
  fail "stale lock from the crashed apply did not block"
fi
lock_id="$(sed -n 's/^ *ID: *\([0-9a-f-]\{36\}\).*/\1/p' "$WORK/d.log" | head -n1)"
[[ -n "$lock_id" ]] || {
  cat "$WORK/d.log" >&2
  fail "could not read the lock ID from the lock error"
}
probe force-unlock -force "$lock_id" >/dev/null || fail "force-unlock $lock_id"
probe apply -input=false -no-color -auto-approve -lock-timeout=0s -var run_id=after-crash >"$WORK/d2.log" 2>&1 || {
  cat "$WORK/d2.log" >&2
  fail "apply after force-unlock"
}
[[ "$(probe output -raw run_id)" == "after-crash" ]] || fail "apply after force-unlock did not update state"
pass "stale lock blocks until tofu force-unlock <id>; then applies resume"

# --- 4. missing credentials fail fast with a clear message -------------------------------------------
echo "==> 4. plan without AWS credentials"
export TF_DATA_DIR="$WORK/dev"
if env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_PROFILE -u AWS_SESSION_TOKEN \
  AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  timeout 120 "$TOFU" -chdir="$TOFU_DIR/environments/dev" plan -input=false -no-color -lock=false -refresh=false \
  >"$WORK/nocreds.log" 2>&1; then
  fail "plan without credentials succeeded"
fi
grep -q 'No valid credential sources found' "$WORK/nocreds.log" || {
  cat "$WORK/nocreds.log" >&2
  fail "plan without credentials did not fail with the credential-chain error"
}
pass "plan without credentials stops with 'No valid credential sources found'"

# --- 5. a manual (out-of-band) change shows up as drift in tofu plan -----------------------------
# Stands in for a console click: a separate, throwaway config with its own state suspends
# versioning on the seeded bucket behind the seed config's back.
echo "==> 5. drift after an out-of-band change"
mkdir -p "$WORK/clickops"
sed -n '/^terraform {/,$p' "$HERE/seed/main.tf" | sed '/^resource /,$d' >"$WORK/clickops/main.tf"
cat >>"$WORK/clickops/main.tf" <<'EOF'
resource "aws_s3_bucket_versioning" "manual" {
  bucket = var.bucket

  versioning_configuration {
    status = "Suspended"
  }
}
EOF
# Reuse the seed's provider lock so init links the cached provider instead of downloading it.
cp "$HERE/seed/.terraform.lock.hcl" "$WORK/clickops/"
export TF_DATA_DIR="$WORK/clickops-data"
seed_vars=(-var "s3_endpoint=$S3_ENDPOINT" -var "dynamodb_endpoint=$DDB_ENDPOINT" -var "bucket=$BUCKET")
"$TOFU" -chdir="$WORK/clickops" init -input=false -no-color -lockfile=readonly >"$WORK/clickops-init.log" 2>&1 || {
  cat "$WORK/clickops-init.log" >&2
  fail "out-of-band config init"
}
"$TOFU" -chdir="$WORK/clickops" apply -input=false -no-color -auto-approve -state="$WORK/clickops.tfstate" \
  "${seed_vars[@]}" >"$WORK/clickops-apply.log" 2>&1 || {
  cat "$WORK/clickops-apply.log" >&2
  fail "out-of-band change"
}
export TF_DATA_DIR="$WORK/seed"
set +e
"$TOFU" -chdir="$HERE/seed" plan -input=false -no-color -detailed-exitcode -state="$WORK/seed.tfstate" \
  "${seed_vars[@]}" >"$WORK/drift.log" 2>&1
rc=$?
set -e
[[ $rc -eq 2 ]] || {
  cat "$WORK/drift.log" >&2
  fail "plan after an out-of-band change exited $rc, expected 2 (changes present)"
}
if ! grep -q 'aws_s3_bucket_versioning.state will be updated in-place' "$WORK/drift.log" ||
  ! grep -q '"Suspended" -> "Enabled"' "$WORK/drift.log"; then
  cat "$WORK/drift.log" >&2
  fail "plan did not report the versioning drift"
fi
pass "tofu plan reports the out-of-band versioning change as drift (exit 2, Suspended -> Enabled)"

echo "==> backend lock tests OK"
