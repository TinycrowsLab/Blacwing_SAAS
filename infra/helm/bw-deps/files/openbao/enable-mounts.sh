#!/bin/sh
# INFRA-010: enables the OpenBao mounts Blackwing needs: transit/ (per-tenant envelope keys, SECRETS-002) and
# secret/ as KV v2 (platform secrets). Runs as the post-install/post-upgrade `openbao-mounts` Job. Idempotent: an
# existing mount is left as it is. The server must already be initialised and unsealed (operator step, see
# README.md). The Job waits for that, and fails after about ten minutes if it never happens.
set -eu

: "${BAO_ADDR:?}" "${BAO_TOKEN:?}"

i=0
until bao status >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "openbao-mounts: OpenBao at $BAO_ADDR is not unsealed after 60 attempts" >&2
    exit 1
  fi
  sleep 10
done

mounts="$(bao secrets list -format=json)"

if printf '%s' "$mounts" | grep -q '"transit/"'; then
  echo "openbao-mounts: transit/ already enabled"
else
  bao secrets enable -path=transit transit >/dev/null
  echo "openbao-mounts: enabled transit/"
fi

if printf '%s' "$mounts" | grep -q '"secret/"'; then
  echo "openbao-mounts: secret/ already enabled"
else
  bao secrets enable -path=secret -version=2 kv >/dev/null
  echo "openbao-mounts: enabled secret/ (KV v2)"
fi

bao secrets list -format=json | grep -q '"transit/"'
bao secrets list -format=json | grep -q '"secret/"'
echo "openbao-mounts: transit/ and secret/ (KV v2) verified"
