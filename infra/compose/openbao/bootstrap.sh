#!/usr/bin/env bash
# Idempotent OpenBao dev bootstrap (DEVENV-005, #159). Run from the host after `pnpm dev:deps`:
#
#   infra/compose/openbao/bootstrap.sh            # `pnpm dev:openbao:bootstrap`
#
# It talks to the HTTP API with curl + jq and, on every run:
#   1. waits for /v1/sys/health (file mode: initialises once and unseals);
#   2. enables Transit at transit/ and checks KV v2 at secret/ (enables it when missing);
#   3. creates one Transit key per tenant (transit/keys/tenant-<slug>, aes256-gcm96, not exportable,
#      deletion disabled) for BW_DEV_OPENBAO_TENANTS (default: acme);
#   4. writes dev placeholder platform secrets under secret/platform/* only when absent (cas=0);
#   5. writes least-privilege policies bw-app-platform + bw-app-tenant-<slug>;
#   6. keeps the app token in $STATE_DIR/app-token (0600) when it is still valid with exactly those
#      policies, otherwise issues a new one from the bw-app token role.
# Nothing that already exists is re-created: no duplicate mounts, keys or secret versions.
# No token or secret is ever printed.
#
# Environment (each falls back to the repo's untracked .env, then to the default):
#   BW_DEV_OPENBAO_ADDR        http://127.0.0.1:${BW_DEV_OPENBAO_PORT:-18200}
#   BW_DEV_OPENBAO_STORAGE     dev | file                       (default dev)
#   BW_DEV_OPENBAO_ROOT_TOKEN  dev-mode root token               (required in dev mode)
#   BW_DEV_OPENBAO_STATE_DIR   <repo>/.bw-dev/openbao            (git-ignored; app-token, init.json)
#   BW_DEV_OPENBAO_TENANTS     space-separated tenant slugs      (default acme)
#   BW_DEV_OPENBAO_WAIT_SECONDS                                  (default 90)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${BW_DEV_ENV_FILE:-$REPO_ROOT/.env}"

log() { printf 'openbao-bootstrap: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# Reads KEY from the .env file without sourcing it (no code execution from .env).
env_file_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

setting() {
  local key="$1" default="${2:-}" value
  value="${!key:-}"
  [[ -n "$value" ]] || value="$(env_file_value "$key")"
  [[ -n "$value" ]] || value="$default"
  printf '%s' "$value"
}

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is required"
done

PORT="$(setting BW_DEV_OPENBAO_PORT 18200)"
ADDR="$(setting BW_DEV_OPENBAO_ADDR "http://127.0.0.1:${PORT}")"
ADDR="${ADDR%/}"
STORAGE="$(setting BW_DEV_OPENBAO_STORAGE dev)"
STATE_DIR="$(setting BW_DEV_OPENBAO_STATE_DIR "$REPO_ROOT/.bw-dev/openbao")"
TENANTS="$(setting BW_DEV_OPENBAO_TENANTS acme)"
WAIT_SECONDS="$(setting BW_DEV_OPENBAO_WAIT_SECONDS 90)"
TOKEN_FILE="$STATE_DIR/app-token"
INIT_FILE="$STATE_DIR/init.json"

[[ "$STORAGE" == dev || "$STORAGE" == file ]] || die "BW_DEV_OPENBAO_STORAGE must be dev or file"
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || die "BW_DEV_OPENBAO_WAIT_SECONDS must be a number"
for t in $TENANTS; do
  [[ "$t" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "invalid tenant slug '$t' (lowercase letters, digits, '-')"
done
[[ -n "${TENANTS// /}" ]] || die "BW_DEV_OPENBAO_TENANTS is empty"

umask 077
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# api METHOD PATH [JSON]: the response body goes to $BODY_FILE (read it with `body`), the status to
# HTTP_CODE (0 when the server is unreachable). Uses $TOKEN when set. The token goes through a curl
# config on stdin, never on the command line (ps / /proc).
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
HTTP_CODE=0
TOKEN=""
api() {
  local method="$1" path="$2" data="${3:-}"
  local -a args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" --config -)
  [[ -n "$data" ]] && args+=(-H 'Content-Type: application/json' --data-binary "$data")
  HTTP_CODE="$(printf 'header = "X-Vault-Token: %s"\n' "$TOKEN" | curl "${args[@]}" "$ADDR/v1/$path" 2>/dev/null)" ||
    HTTP_CODE=0
}
body() { cat "$BODY_FILE"; }

expect() {
  local what="$1"
  shift
  local code
  for code in "$@"; do [[ "$HTTP_CODE" == "$code" ]] && return 0; done
  die "$what failed (HTTP $HTTP_CODE)"
}

# --- 1. wait for the server --------------------------------------------------------------------
log "waiting for $ADDR (up to ${WAIT_SECONDS}s)"
deadline=$((SECONDS + WAIT_SECONDS))
while :; do
  api GET 'sys/health?uninitcode=200&sealedcode=200&standbycode=200'
  health="$(body)"
  [[ "$HTTP_CODE" == 200 ]] && break
  ((SECONDS < deadline)) || die "OpenBao at $ADDR is not answering /v1/sys/health"
  sleep 1
done

initialized="$(jq -r '.initialized' <<<"$health")"
sealed="$(jq -r '.sealed' <<<"$health")"

if [[ "$STORAGE" == file ]]; then
  if [[ "$initialized" != true ]]; then
    log "initialising the persistent dev server (1 key share; dev only)"
    api POST sys/init '{"secret_shares":1,"secret_threshold":1}'
    init="$(body)"
    expect 'sys/init' 200
    printf '%s\n' "$init" >"$INIT_FILE"
    chmod 600 "$INIT_FILE"
    sealed=true
  fi
  [[ -f "$INIT_FILE" ]] || die "server is initialised but $INIT_FILE is missing (reset the openbaodata volume)"
  if [[ "$sealed" == true ]]; then
    log "unsealing"
    key="$(jq -r '.keys_base64[0]' "$INIT_FILE")"
    api POST sys/unseal "$(jq -cn --arg k "$key" '{key: $k}')"
    expect 'sys/unseal' 200
    unset key
  fi
  TOKEN="$(jq -r '.root_token' "$INIT_FILE")"
else
  [[ "$initialized" == true && "$sealed" == false ]] || die "dev server is not initialised/unsealed"
  TOKEN="$(setting BW_DEV_OPENBAO_ROOT_TOKEN)"
  [[ -n "$TOKEN" ]] || die "BW_DEV_OPENBAO_ROOT_TOKEN is not set (pnpm dev:deps writes it to .env)"
fi

deadline=$((SECONDS + WAIT_SECONDS))
while :; do
  api GET sys/health
  [[ "$HTTP_CODE" == 200 ]] && break
  ((SECONDS < deadline)) || die "OpenBao did not become active (HTTP $HTTP_CODE)"
  sleep 1
done

api GET auth/token/lookup-self
expect 'root token check' 200

# --- 2. mounts ---------------------------------------------------------------------------------
api GET sys/mounts
mounts="$(body)"
expect 'sys/mounts' 200

transit_type="$(jq -r '.data["transit/"].type // empty' <<<"$mounts")"
if [[ -z "$transit_type" ]]; then
  api POST sys/mounts/transit '{"type":"transit","description":"Blackwing per-tenant envelope keys"}'
  expect 'enable transit' 200 204
  log "enabled transit/"
elif [[ "$transit_type" != transit ]]; then
  die "transit/ is mounted as '$transit_type', expected transit"
else
  log "transit/ already enabled"
fi

kv_type="$(jq -r '.data["secret/"].type // empty' <<<"$mounts")"
kv_version="$(jq -r '.data["secret/"].options.version // empty' <<<"$mounts")"
if [[ -z "$kv_type" ]]; then
  api POST sys/mounts/secret '{"type":"kv","options":{"version":"2"},"description":"Blackwing platform secrets"}'
  expect 'enable kv-v2' 200 204
  log "enabled kv-v2 at secret/"
elif [[ "$kv_type" != kv || "$kv_version" != 2 ]]; then
  die "secret/ is mounted as '$kv_type' v'$kv_version', expected kv v2"
else
  log "secret/ (kv-v2) already enabled"
fi

api GET sys/audit
audit="$(body)"
expect 'sys/audit' 200
if [[ "$(jq '.data | length' <<<"$audit")" -lt 1 ]]; then
  die "no audit device is enabled (infra/compose/openbao/config/audit.hcl was not loaded)"
fi

# --- 3. per-tenant transit keys ----------------------------------------------------------------
for t in $TENANTS; do
  key="tenant-$t"
  api GET "transit/keys/$key"
  if [[ "$HTTP_CODE" == 404 ]]; then
    api POST "transit/keys/$key" '{"type":"aes256-gcm96","exportable":false,"allow_plaintext_backup":false}'
    expect "create transit key $key" 200 204
    log "created transit/keys/$key"
  else
    expect "read transit key $key" 200
    log "transit/keys/$key already exists"
  fi
  api POST "transit/keys/$key/config" '{"deletion_allowed":false}'
  expect "configure transit key $key" 200 204
done

# --- 4. platform placeholder secrets (written only when absent) ---------------------------------
put_secret() {
  local path="$1" data="$2"
  api POST "secret/data/$path" "$(jq -cn --argjson d "$data" '{options: {cas: 0}, data: $d}')"
  if [[ "$HTTP_CODE" == 200 || "$HTTP_CODE" == 204 ]]; then
    log "wrote secret/$path"
  elif [[ "$HTTP_CODE" == 400 ]]; then
    log "secret/$path already exists (kept)"
  else
    die "write secret/$path failed (HTTP $HTTP_CODE)"
  fi
}
# Dev placeholders only: they point at the local Mailpit and interactsh-local, never real services.
put_secret platform/smtp '{"host":"mailpit","port":"1025","username":"dev-placeholder","password":"dev-placeholder","from":"blackwing@localhost"}'
put_secret platform/interactsh '{"server_url":"http://interactsh:80","token":"dev-placeholder"}'

# --- 5. least-privilege policies ---------------------------------------------------------------
put_policy() {
  local name="$1" hcl="$2"
  api PUT "sys/policies/acl/$name" "$(jq -cn --arg p "$hcl" '{policy: $p}')"
  expect "write policy $name" 200 204
}

put_policy bw-app-platform "$(cat <<'HCL'
# Blackwing app services: read-only access to platform secrets. Nothing else in secret/.
path "secret/data/platform/*" {
  capabilities = ["read"]
}
path "secret/metadata/platform/*" {
  capabilities = ["read", "list"]
}
HCL
)"

policies='["bw-app-platform"'
for t in $TENANTS; do
  put_policy "bw-app-tenant-$t" "$(cat <<HCL
# Envelope-encryption operations with tenant $t's Transit key only. No key read, export,
# backup, config, rotate or delete.
path "transit/encrypt/tenant-$t" {
  capabilities = ["update"]
}
path "transit/decrypt/tenant-$t" {
  capabilities = ["update"]
}
path "transit/rewrap/tenant-$t" {
  capabilities = ["update"]
}
path "transit/datakey/plaintext/tenant-$t" {
  capabilities = ["update"]
}
path "transit/datakey/wrapped/tenant-$t" {
  capabilities = ["update"]
}
HCL
)"
  policies+=",\"bw-app-tenant-$t\""
done
policies+=']'
log "policies written: $(jq -r 'join(", ")' <<<"$policies")"

# --- 6. app token ------------------------------------------------------------------------------
api POST auth/token/roles/bw-app "$(jq -cn --argjson p "$policies" '{
  allowed_policies: $p, disallowed_policies: ["root"], orphan: true, renewable: true,
  token_period: "768h", token_type: "service", token_no_default_policy: false
}')"
expect 'write token role bw-app' 200 204

want="$(jq -c 'sort' <<<"$policies")"
reuse=false
if [[ -s "$TOKEN_FILE" ]]; then
  root_token="$TOKEN"
  TOKEN="$(tr -d '\n' <"$TOKEN_FILE")"
  api GET auth/token/lookup-self
  self="$(body)"
  if [[ "$HTTP_CODE" == 200 ]]; then
    have="$(jq -c '[.data.policies[] | select(. != "default")] | sort' <<<"$self")"
    [[ "$have" == "$want" ]] && reuse=true
  fi
  TOKEN="$root_token"
fi

if [[ "$reuse" == true ]]; then
  log "app token in $TOKEN_FILE is valid; kept"
else
  api POST auth/token/create/bw-app "$(jq -cn --argjson p "$policies" '{policies: $p, display_name: "bw-app-dev"}')"
  created="$(body)"
  expect 'create app token' 200
  tmp="$TOKEN_FILE.tmp"
  jq -r '.auth.client_token' <<<"$created" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$TOKEN_FILE"
  log "issued a new app token -> $TOKEN_FILE"
fi

log "done (tenants: $TENANTS)"
