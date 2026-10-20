#!/usr/bin/env bash
# DEVENV-006: idempotent MinIO bootstrap. Runs inside the `minio-init` compose job (mc image), so it
# needs no host `mc` (on many hosts `mc` is Midnight Commander). Safe to re-run: existing buckets are
# verified, never recreated, and a bucket without Object Lock fails the run (Object Lock can only be
# enabled at creation, so the fix is to empty and delete the bucket, then re-run).
#
# Env: MINIO_ENDPOINT (default http://minio:9000), MINIO_ROOT_USER, MINIO_ROOT_PASSWORD,
#      BW_APP_ACCESS_KEY, BW_APP_SECRET_KEY, BW_RETENTION_MODE (GOVERNANCE|COMPLIANCE), BW_RETENTION_DAYS.
set -euo pipefail

MC="${MC_BIN:-mc}"
ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"
BUCKETS=(bw-evidence bw-reports bw-transcripts)
POLICY_NAME=bw-app
POLICY_FILE="${BW_POLICY_FILE:-/bw/minio/policy-app.json}"
# Dev default is GOVERNANCE (an admin can still clean up disk). Prod S3 uses COMPLIANCE; see README.
MODE="${BW_RETENTION_MODE:-GOVERNANCE}"
DAYS="${BW_RETENTION_DAYS:-1}"

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${BW_APP_ACCESS_KEY:?BW_APP_ACCESS_KEY is required}"
: "${BW_APP_SECRET_KEY:?BW_APP_SECRET_KEY is required}"
case "$MODE" in
  GOVERNANCE | COMPLIANCE) ;;
  *) echo "BW_RETENTION_MODE must be GOVERNANCE or COMPLIANCE" >&2; exit 2 ;;
esac
case "$DAYS" in
  '' | *[!0-9]* | 0) echo "BW_RETENTION_DAYS must be a positive integer" >&2; exit 2 ;;
esac

# Alias via env (no credentials on the command line, none written to disk).
scheme="${ENDPOINT%%://*}"
hostport="${ENDPOINT#*://}"
export MC_HOST_bw="${scheme}://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@${hostport}"

MARKER=/tmp/bw-minio-bootstrap.ok
rm -f "$MARKER"

log() { printf 'minio-bootstrap: %s\n' "$*"; }

for _ in $(seq 1 60); do
  if "$MC" ready bw >/dev/null 2>&1; then break; fi
  sleep 2
done
"$MC" ready bw >/dev/null 2>&1 || { log "MinIO not ready at $ENDPOINT"; exit 1; }

for b in "${BUCKETS[@]}"; do
  if "$MC" stat "bw/$b" >/dev/null 2>&1; then
    log "bucket $b exists (skipped)"
  else
    "$MC" mb --with-lock "bw/$b" >/dev/null
    log "bucket $b created with object lock"
  fi
  "$MC" version enable "bw/$b" >/dev/null
  # Enforce: Object Lock cannot be enabled after creation, so setting the default retention fails on a
  # bucket created without it. That is a hard failure (no silent downgrade of WORM).
  if ! "$MC" retention set --default "$MODE" "${DAYS}d" "bw/$b" >/dev/null 2>&1; then
    log "FATAL: bucket $b has no object lock (it cannot be enabled later). Empty and delete it, then re-run."
    exit 1
  fi
  info=$("$MC" retention info --default "bw/$b" 2>&1)
  if [[ "$info" != *"'$MODE' is configured for ${DAYS}DAYS"* ]]; then
    log "FATAL: bucket $b default retention is not $MODE ${DAYS}d: $info"
    exit 1
  fi
done

# Scoped app identity: object read/write on the three buckets, no admin and no version deletes.
"$MC" admin policy create bw "$POLICY_NAME" "$POLICY_FILE" >/dev/null
"$MC" admin user add bw "$BW_APP_ACCESS_KEY" "$BW_APP_SECRET_KEY" >/dev/null
attached=$("$MC" admin user info bw "$BW_APP_ACCESS_KEY" 2>/dev/null || true)
if [[ "$attached" == *"PolicyName: $POLICY_NAME"* ]]; then
  log "policy $POLICY_NAME already attached (skipped)"
else
  "$MC" admin policy attach bw "$POLICY_NAME" --user "$BW_APP_ACCESS_KEY" >/dev/null
  log "policy $POLICY_NAME attached to the app key"
fi
log "done (default retention: $MODE ${DAYS}d, UTC)"
touch "$MARKER"
