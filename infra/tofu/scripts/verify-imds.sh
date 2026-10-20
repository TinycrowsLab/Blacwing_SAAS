#!/usr/bin/env bash
# Verifies the IMDS hardening of INFRA-003 ON a running node (run it on the node itself).
# Never run by CI or offline: it needs an EC2 instance launched with the module's metadata_options.
#
#   host        IMDSv1 (no token) must return 401, and IMDSv2 from the host must work.
#   container   with --container IMAGE, IMDSv2 from a container (an extra hop) must fail.
#
# Usage: verify-imds.sh [--container IMAGE]   (IMAGE's entrypoint must be curl, e.g. curlimages/curl)
set -euo pipefail

IMDS="http://169.254.169.254"
fail=0

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then
    echo "ok    $1 ($3)"
  else
    echo "FAIL  $1: expected $2, got $3" >&2
    fail=1
  fi
}

v1="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$IMDS/latest/meta-data/instance-id" || true)"
check "host IMDSv1 is refused" 401 "$v1"

token="$(curl -s -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "$IMDS/latest/api/token" || true)"
if [[ -n "$token" ]]; then
  echo "ok    host IMDSv2 works"
else
  echo "FAIL  host IMDSv2 token request failed" >&2
  fail=1
fi

if [[ "${1:-}" == "--container" ]]; then
  image="${2:?--container needs an image}"
  inner="$(docker run --rm --network bridge "$image" -s -o /dev/null -m 3 -X PUT \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' -w '%{http_code}' "$IMDS/latest/api/token" || true)"
  if [[ "$inner" == "200" ]]; then
    echo "FAIL  container obtained an IMDSv2 token (hop limit above 1?)" >&2
    fail=1
  else
    echo "ok    container IMDSv2 blocked (${inner:-timeout})"
  fi
fi

exit "$fail"
