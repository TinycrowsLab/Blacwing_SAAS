#!/usr/bin/env bash
# Integration test for evidence Object Lock semantics (INFRA-006), run fully offline.
#
# OFFLINE-STUB(online-porting #888): MinIO stands in for AWS S3. MinIO implements Object Lock
# (COMPLIANCE retention, legal hold) but not KMS key policies, the TLS bucket-policy condition on
# anonymous HTTP, or SSE-KMS encryption-context enforcement. Those assertions must be repeated
# against real S3/KMS (see the porting issue).
#
# Proves, against a bucket created with Object Lock and a COMPLIANCE default retention:
#   1. the lock configuration reads back as COMPLIANCE with the default retention;
#   2. deleting a locked version fails; an overwrite creates a new version and the locked one survives;
#   3. a legal hold keeps a version undeletable after its retention has passed, until released;
#   4. Object Lock cannot be enabled on a bucket created without it.
# Requires docker and the aws CLI. Containers are removed on exit.
set -euo pipefail

MINIO_IMAGE='cgr.dev/chainguard/minio:latest@sha256:cff197fef764642223ef9f4444c903d51aee9b544a7be8bc007fef6b7b00d136'
LABEL="blackwing.test=tofu-object-lock-$$"
container=""
WORK="$(mktemp -d)"
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }
rand() { head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c "$1"; }

ACCESS="bwtest$(rand 10)"
SECRET="$(rand 32)"
container="$(docker run -d --rm --label "$LABEL" -p 127.0.0.1::9000 \
  -e MINIO_ROOT_USER="$ACCESS" -e MINIO_ROOT_PASSWORD="$SECRET" \
  "$MINIO_IMAGE" server /data --address :9000)"
ENDPOINT="http://127.0.0.1:$(docker port "$container" 9000/tcp | head -n1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  curl -fsS "$ENDPOINT/minio/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$ENDPOINT/minio/health/ready" >/dev/null || fail "MinIO did not become ready"

s3() { AWS_ACCESS_KEY_ID="$ACCESS" AWS_SECRET_ACCESS_KEY="$SECRET" AWS_DEFAULT_REGION=eu-central-1 \
  aws --endpoint-url "$ENDPOINT" --no-cli-pager "$@"; }
EV=bw-test-evidence
PLAIN=bw-test-plain
TENANT_KEY="t/tnt_01/evidence-1.txt"

# Same settings as modules/storage: lock at creation, versioning, COMPLIANCE default retention.
s3 s3api create-bucket --bucket "$EV" --object-lock-enabled-for-bucket >/dev/null
s3 s3api put-object-lock-configuration --bucket "$EV" --object-lock-configuration \
  '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":30}}}'

# 1. Configuration reads back.
cfg="$(s3 s3api get-object-lock-configuration --bucket "$EV")"
grep -q '"COMPLIANCE"' <<<"$cfg" && grep -q '"Days": 30' <<<"$cfg" || fail "lock configuration: $cfg"
pass "evidence bucket reports Object Lock Enabled, COMPLIANCE, 30 days"

# 2. Delete / overwrite of a locked version.
echo v1 >"$WORK/v1"
vid1="$(s3 s3api put-object --bucket "$EV" --key "$TENANT_KEY" --body "$WORK/v1" --query VersionId --output text)"
if s3 s3api delete-object --bucket "$EV" --key "$TENANT_KEY" --version-id "$vid1" >/dev/null 2>"$WORK/del.err"; then
  fail "deleting a locked version succeeded"
fi
grep -qi 'AccessDenied\|locked\|retention\|WORM' "$WORK/del.err" || fail "unexpected delete error: $(cat "$WORK/del.err")"
if s3 s3api delete-object --bucket "$EV" --key "$TENANT_KEY" --version-id "$vid1" \
  --bypass-governance-retention >/dev/null 2>&1; then
  fail "bypass-governance-retention removed a COMPLIANCE version"
fi
echo v2 >"$WORK/v2"
vid2="$(s3 s3api put-object --bucket "$EV" --key "$TENANT_KEY" --body "$WORK/v2" --query VersionId --output text)"
[[ "$vid1" != "$vid2" ]] || fail "overwrite did not create a new version"
s3 s3api get-object --bucket "$EV" --key "$TENANT_KEY" --version-id "$vid1" "$WORK/out1" >/dev/null
[[ "$(cat "$WORK/out1")" == v1 ]] || fail "locked version content changed after overwrite"
s3 s3api delete-object --bucket "$EV" --key "$TENANT_KEY" >/dev/null # delete marker only
s3 s3api get-object --bucket "$EV" --key "$TENANT_KEY" --version-id "$vid1" "$WORK/out1b" >/dev/null ||
  fail "locked version vanished behind a delete marker"
pass "locked version cannot be deleted, bypassed or overwritten away"

# 3. Legal hold outlives retention: hold a version with an already-expiring short retention.
s3 s3api put-object --bucket "$EV" --key "t/tnt_01/held.txt" --body "$WORK/v1" \
  --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$(date -u -d '+10 seconds' +%Y-%m-%dT%H:%M:%SZ)" \
  --object-lock-legal-hold-status ON >"$WORK/held.json"
held_vid="$(sed -n 's/.*"VersionId": *"\([^"]*\)".*/\1/p' "$WORK/held.json")"
sleep 12
if s3 s3api delete-object --bucket "$EV" --key "t/tnt_01/held.txt" --version-id "$held_vid" >/dev/null 2>&1; then
  fail "version under legal hold was deleted after retention passed"
fi
s3 s3api put-object-legal-hold --bucket "$EV" --key "t/tnt_01/held.txt" --version-id "$held_vid" \
  --legal-hold Status=OFF >/dev/null
s3 s3api delete-object --bucket "$EV" --key "t/tnt_01/held.txt" --version-id "$held_vid" >/dev/null ||
  fail "version not deletable after hold release and retention expiry"
pass "legal hold keeps the version after retention passes; releasing it allows deletion"

# 4. Object Lock cannot be added to an existing bucket (must be set at creation).
s3 s3api create-bucket --bucket "$PLAIN" >/dev/null
if s3 s3api put-object-lock-configuration --bucket "$PLAIN" --object-lock-configuration \
  '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":1}}}' >/dev/null 2>&1; then
  fail "Object Lock was enabled on a bucket created without it"
fi
pass "Object Lock cannot be enabled on an existing bucket"

echo "==> object lock integration test OK"
