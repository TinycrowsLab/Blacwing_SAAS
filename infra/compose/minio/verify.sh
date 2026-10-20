#!/usr/bin/env bash
# DEVENV-006: proves the WORM and least-privilege properties of the dev object store. Run inside the
# minio-init container (see infra/compose/README.md and scripts/compose-smoke.mjs):
#   docker compose -p bwdev exec -T minio-init /bin/bash /bw/minio/verify.sh
# Leaves nothing behind that it cannot remove: test objects live under bw-evidence/<tenant>/verify/ with
# GOVERNANCE retention (the default), and are removed at the end with an explicit governance bypass.
set -uo pipefail

MC="${MC_BIN:-mc}"
ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"
scheme="${ENDPOINT%%://*}"
hostport="${ENDPOINT#*://}"
export MC_HOST_bw="${scheme}://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@${hostport}"
export MC_HOST_app="${scheme}://${BW_APP_ACCESS_KEY}:${BW_APP_SECRET_KEY}@${hostport}"

failures=0
ok() { printf 'ok - %s\n' "$1"; }
fail() { printf 'FAIL - %s\n' "$1"; failures=$((failures + 1)); }
check() { local n=$1; shift; if "$@"; then ok "$n"; else fail "$n"; fi; }
contains() { [[ "$1" == *"$2"* ]]; }
equals() { [[ "$1" == "$2" ]]; }
# expect_ok <name> <cmd...>   /   expect_denied <name> <cmd...>
expect_ok() { local n=$1; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else fail "$n"; fi; }
expect_denied() { local n=$1; shift; if "$@" >/dev/null 2>&1; then fail "$n (was allowed)"; else ok "$n"; fi; }

tenant="00000000-0000-7000-8000-$(printf '%012x' "$$")"
key="$tenant/verify/object-$(date -u +%s)-$$.txt"
obj="bw-evidence/$key"

# 1. Buckets exist with versioning and a default retention (object lock).
for b in bw-evidence bw-reports bw-transcripts; do
  v=$("$MC" version info "bw/$b" 2>&1)
  check "$b versioning enabled" contains "$v" "enabled"
  r=$("$MC" retention info --default "bw/$b" 2>&1)
  check "$b object lock default retention is set" contains "$r" "is configured for"
done

# 2. The scoped key reads and writes objects and lists the buckets.
printf 'original-evidence' >/tmp/bw-verify-1
printf 'tampered-evidence' >/tmp/bw-verify-2
expect_ok "app key can write an object" "$MC" cp /tmp/bw-verify-1 "app/$obj"
expect_ok "app key can read the object" "$MC" cat "app/$obj"
expect_ok "app key can list the bucket" "$MC" ls "app/bw-evidence/$tenant/"
expect_ok "app key can set a legal hold" "$MC" legalhold set "app/$obj"
stat_json=$("$MC" stat --json "bw/$obj" 2>/dev/null)
version=""
if [[ "$stat_json" =~ \"versionID\":\"([^\"]+)\" ]]; then version="${BASH_REMATCH[1]}"; fi
check "object has a version id" test -n "$version"
if [[ -z "$version" ]]; then printf 'cannot continue without a version id\n'; exit 1; fi

# 3. Overwrite never destroys the original: it becomes a new version, the first stays intact.
expect_ok "overwrite creates a new version" "$MC" cp /tmp/bw-verify-2 "app/$obj"
check "original version unchanged after overwrite" equals "$("$MC" cat --version-id "$version" "app/$obj" 2>/dev/null)" "original-evidence"

# 4. Deleting a locked version is rejected, for the app key and for root; a legal hold survives bypass.
expect_denied "app key cannot delete a version" "$MC" rm --version-id "$version" "app/$obj"
expect_denied "root cannot delete a retained version" "$MC" rm --version-id "$version" "bw/$obj"
expect_denied "root cannot delete a held version even with governance bypass" \
  "$MC" rm --version-id "$version" --bypass "bw/$obj"
"$MC" legalhold clear "app/$obj" --version-id "$version" >/dev/null 2>&1
expect_denied "root cannot delete a retained version after the hold is cleared (no bypass)" \
  "$MC" rm --version-id "$version" "bw/$obj"
check "locked version still readable" equals "$("$MC" cat --version-id "$version" "app/$obj" 2>/dev/null)" "original-evidence"

# 5. The app key is not an admin.
expect_denied "app key cannot list users" "$MC" admin user list app
expect_denied "app key cannot create a bucket" "$MC" mb app/bw-rogue
expect_denied "app key cannot change default retention" "$MC" retention set --default GOVERNANCE 1d app/bw-evidence
expect_denied "app key cannot disable versioning" "$MC" version suspend app/bw-evidence
expect_denied "app key cannot read other buckets" "$MC" ls app/some-other-bucket

# 6. Cleanup: governance bypass by root only (never available to the app key).
"$MC" rm --recursive --force --versions --bypass "bw/bw-evidence/$tenant/" >/dev/null 2>&1
rm -f /tmp/bw-verify-1 /tmp/bw-verify-2

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures"
  exit 1
fi
printf 'all checks passed\n'
