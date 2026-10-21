#!/usr/bin/env bash
# bw-k3s-bootstrap: installs the pinned k3s release on a Blackwing node and joins it (INFRA-004).
#
# Run by cloud-init (runcmd) with the non-secret settings in /etc/blackwing/k3s-node.env and the
# k3s config in /etc/rancher/k3s/config.yaml, both written by the launch template. Idempotent: a
# re-run keeps verified artifacts and existing tokens and only (re)starts what is missing.
#
#   server (control-plane): reads the join tokens from SSM; on the very first boot (placeholder
#     value) generates them and writes them back. Starts k3s, waits for /readyz, then publishes its
#     version and the admin kubeconfig (internal API URL) as SSM parameters.
#   agent (sandbox, egress): refuses to join unless the server reports exactly the pinned version
#     (pre-join drift check), reads the agent-only token from SSM and starts k3s-agent.
#
# Secrets (join tokens, AWS credentials) never appear in argv, logs or user-data: they move through
# pipes, curl config on stdin and 0600 files. Every network step retries with exponential backoff;
# on failure the log is shipped to CloudWatch and printed on the console (cloud-init output).
#
# Test hooks: BW_ROOT prefixes every filesystem path and BW_IMDS_URL replaces the metadata endpoint
# (scripts/k3s-node-bootstrap.test.mjs runs this script against fakes).
set -Eeuo pipefail
umask 077

ROOT="${BW_ROOT:-}"
ENV_FILE="${BW_ENV_FILE:-$ROOT/etc/blackwing/k3s-node.env}"
IMDS="${BW_IMDS_URL:-http://169.254.169.254}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "bw-k3s-bootstrap: $ENV_FILE is missing" >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$ENV_FILE"

for required in BW_NODE_ROLE BW_POOL BW_K3S_VERSION BW_K3S_SHA256 BW_K3S_AIRGAP_SHA256 BW_K3S_BASE_URL \
  BW_AWS_REGION BW_KMS_KEY_ARN BW_SSM_AGENT_TOKEN BW_SSM_SERVER_VERSION BW_TOKEN_PLACEHOLDER BW_API_HOST BW_API_PORT; do
  if [[ -z "${!required:-}" ]]; then
    echo "bw-k3s-bootstrap: $required is not set in $ENV_FILE" >&2
    exit 2
  fi
done
case "$BW_NODE_ROLE" in
  server | agent) ;;
  *)
    echo "bw-k3s-bootstrap: BW_NODE_ROLE must be server or agent" >&2
    exit 2
    ;;
esac

MAX_ATTEMPTS="${BW_MAX_ATTEMPTS:-30}"
BACKOFF_BASE="${BW_BACKOFF_BASE_SECONDS:-2}"
BACKOFF_MAX="${BW_BACKOFF_MAX_SECONDS:-60}"

BIN_DIR="$ROOT/usr/local/bin"
K3S_ETC="$ROOT/etc/rancher/k3s"
IMAGES_DIR="$ROOT/var/lib/rancher/k3s/agent/images"
UNIT_DIR="$ROOT/etc/systemd/system"
LOG_DIR="$ROOT/var/log/blackwing"
LOG_FILE="$LOG_DIR/k3s-bootstrap.log"
CLOUD_INIT_LOG="$ROOT/var/log/cloud-init-output.log"

mkdir -p "$BIN_DIR" "$K3S_ETC" "$IMAGES_DIR" "$UNIT_DIR" "$LOG_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bw-k3s.XXXXXX")"

# --- logging ---------------------------------------------------------------------------------

# One JSON object per line, to stderr (cloud-init output, instance console) and the log file.
log() {
  local level="$1" event="$2" msg="${3:-}"
  msg="${msg//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  printf '{"ts":"%s","level":"%s","event":"%s","pool":"%s","role":"%s","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$event" "$BW_POOL" "$BW_NODE_ROLE" "$msg" | tee -a "$LOG_FILE" >&2
}

# retry <what> <command...>: exponential backoff (base * 2^n, capped), MAX_ATTEMPTS attempts.
retry() {
  local what="$1" attempt=1 delay exp
  shift
  while true; do
    if "$@"; then
      return 0
    fi
    if ((attempt >= MAX_ATTEMPTS)); then
      log error retry_exhausted "$what failed after $attempt attempts"
      return 1
    fi
    exp=$((attempt - 1))
    ((exp > 10)) && exp=10
    delay=$((BACKOFF_BASE * (1 << exp)))
    ((delay > BACKOFF_MAX)) && delay="$BACKOFF_MAX"
    log warn retry "$what failed (attempt $attempt/$MAX_ATTEMPTS), retrying in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

# --- AWS (IMDSv2 credentials + SigV4 via curl; no AWS CLI on the air-gapped nodes) -----------

imds_get() {
  local token
  token="$(curl -fsS --max-time 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' "$IMDS/latest/api/token")" || return 1
  printf 'header = "X-aws-ec2-metadata-token: %s"\n' "$token" | curl -fsS --max-time 5 -K - "$IMDS/latest/$1"
}

# Prints AccessKeyId, SecretAccessKey and Token on three lines (stdout only, never argv).
imds_credentials() {
  local role
  role="$(imds_get meta-data/iam/security-credentials/ | head -n 1)" || return 1
  [[ -n "$role" ]] || return 1
  imds_get "meta-data/iam/security-credentials/$role" |
    python3 -c 'import json,sys; c=json.load(sys.stdin); print(c["AccessKeyId"]); print(c["SecretAccessKey"]); print(c["Token"])'
}

# aws_call <ssm|logs> <Target> <body-file>: one JSON API call; credentials go through curl -K -.
aws_call() {
  local service="$1" target="$2" body="$3" prefix creds ak sk st
  case "$service" in
    ssm) prefix="AmazonSSM" ;;
    logs) prefix="Logs_20140328" ;;
    *) return 2 ;;
  esac
  creds="$(imds_credentials)" || return 1
  {
    read -r ak
    read -r sk
    read -r st
  } <<<"$creds"
  printf 'user = "%s:%s"\nheader = "x-amz-security-token: %s"\n' "$ak" "$sk" "$st" |
    curl -fsS --max-time 20 -K - --aws-sigv4 "aws:amz:$BW_AWS_REGION:$service" \
      -H "X-Amz-Target: $prefix.$target" -H 'Content-Type: application/x-amz-json-1.1' \
      --data-binary "@$body" "https://$service.$BW_AWS_REGION.amazonaws.com/"
}

ssm_get() {
  local body="$WORK/get.json" out
  python3 -c 'import json,sys; print(json.dumps({"Name": sys.argv[1], "WithDecryption": True}))' "$1" >"$body"
  out="$(aws_call ssm GetParameter "$body")" || return 1
  printf '%s' "$out" | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["Parameter"]["Value"])'
}

# ssm_put <name> <value-file> <String|SecureString> [tier]: the value is read from a 0600 file.
ssm_put() {
  local body="$WORK/put.json"
  python3 - "$1" "$2" "$3" "${4:-}" "$BW_KMS_KEY_ARN" >"$body" <<'PY' || return 1
import json, sys
name, value_file, kind, tier, key = sys.argv[1:6]
with open(value_file, encoding="utf-8") as f:
    req = {"Name": name, "Value": f.read(), "Type": kind, "Overwrite": True}
if kind == "SecureString":
    req["KeyId"] = key
if tier:
    req["Tier"] = tier
print(json.dumps(req))
PY
  aws_call ssm PutParameter "$body" >/dev/null
  local rc=$?
  rm -f "$body"
  return "$rc"
}

ship_logs() {
  [[ -n "${BW_LOG_GROUP:-}" ]] || return 0
  local iid stream body="$WORK/logs.json"
  iid="$(imds_get meta-data/instance-id)" || return 1
  stream="$iid/bootstrap"
  python3 -c 'import json,sys; print(json.dumps({"logGroupName": sys.argv[1], "logStreamName": sys.argv[2]}))' \
    "$BW_LOG_GROUP" "$stream" >"$body"
  aws_call logs CreateLogStream "$body" >/dev/null 2>&1 || true # already exists on a re-run
  python3 - "$BW_LOG_GROUP" "$stream" "$LOG_FILE" "$CLOUD_INIT_LOG" >"$body" <<'PY' || return 1
import json, os, sys, time
group, stream, *files = sys.argv[1:]
now = int(time.time() * 1000)
events = []
for path in files:
    if os.path.exists(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f.read().splitlines()[-500:]:
                if line.strip():
                    events.append({"timestamp": now, "message": line[:8000]})
print(json.dumps({"logGroupName": group, "logStreamName": stream, "logEvents": events or [{"timestamp": now, "message": "no log"}]}))
PY
  aws_call logs PutLogEvents "$body" >/dev/null
}

on_exit() {
  local rc=$?
  trap - EXIT
  if ((rc == 0)); then
    log info bootstrap_complete "node bootstrap finished"
  else
    log error bootstrap_failed "node bootstrap failed with exit code $rc; see $LOG_FILE"
  fi
  ship_logs || log warn log_ship_failed "could not ship the bootstrap log to CloudWatch"
  rm -rf "$WORK"
  exit "$rc"
}
trap on_exit EXIT

die() {
  log error "$1" "$2"
  exit "${3:-1}"
}

# --- host preparation ------------------------------------------------------------------------

time_synced() {
  [[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" == "yes" ]]
}

digest() {
  "$1sum" "$2" | cut -d' ' -f1
}

download() {
  curl -fsSL --max-time 900 -o "$2" "$1"
}

# fetch_verified <url> <dest> <sha256|sha512> <expected>: keeps a verified file, else downloads.
fetch_verified() {
  local url="$1" dest="$2" algo="$3" want="$4" part="$2.part" got
  if [[ -f "$dest" && "$(digest "$algo" "$dest")" == "$want" ]]; then
    log info artifact_present "$(basename "$dest") already installed and verified"
    return 0
  fi
  retry "download $(basename "$dest")" download "$url" "$part" || return 1
  got="$(digest "$algo" "$part")"
  if [[ "$got" != "$want" ]]; then
    rm -f "$part"
    log error checksum_mismatch "$(basename "$dest") from $url has $algo $got, expected $want"
    return 1
  fi
  mv -f "$part" "$dest"
  log info artifact_installed "$(basename "$dest") verified ($algo)"
}

installed_k3s_version() {
  "$BIN_DIR/k3s" --version 2>/dev/null | awk 'NR == 1 { print $3 }'
}

install_k3s() {
  local release="${BW_K3S_VERSION//+/%2B}" have
  fetch_verified "$BW_K3S_BASE_URL/$release/k3s" "$BIN_DIR/k3s" sha256 "$BW_K3S_SHA256" ||
    die k3s_install_failed "could not install k3s $BW_K3S_VERSION"
  chmod 0755 "$BIN_DIR/k3s"
  have="$(installed_k3s_version)"
  [[ "$have" == "$BW_K3S_VERSION" ]] ||
    die version_drift "installed k3s reports '$have' but $BW_K3S_VERSION is pinned" 3
  fetch_verified "$BW_K3S_BASE_URL/$release/k3s-airgap-images-amd64.tar.zst" \
    "$IMAGES_DIR/k3s-airgap-images-amd64.tar.zst" sha256 "$BW_K3S_AIRGAP_SHA256" ||
    die k3s_install_failed "could not install the k3s air-gap images"
}

# Register the runsc handler in k3s's containerd (INFRA-005). The template is rewritten on every
# boot, so a reboot or replaced node always re-applies it; it extends k3s's own base config.
write_containerd_runsc() {
  local dir="$ROOT/var/lib/rancher/k3s/agent/etc/containerd"
  mkdir -p "$dir"
  cat >"$dir/config-v3.toml.tmpl.tmp" <<'TOML'
{{ template "base" . }}

# Blackwing (INFRA-005): gVisor as the `runsc` handler behind RuntimeClass gvisor.
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
TOML
  mv -f "$dir/config-v3.toml.tmpl.tmp" "$dir/config-v3.toml.tmpl"
}

# gVisor on sandbox nodes: binaries (pinned, sha512-verified) plus the containerd handler.
install_runsc() {
  [[ "${BW_INSTALL_RUNSC:-false}" == "true" ]] || return 0
  local bundle="$ROOT/var/lib/blackwing/gvisor-$BW_RUNSC_VERSION.tar.bz2" staged="$WORK/gvisor" bin
  mkdir -p "$(dirname "$bundle")" "$staged"
  fetch_verified "$BW_RUNSC_BASE_URL/$BW_RUNSC_VERSION/x86_64/gvisor.tar.bz2" "$bundle" sha512 "$BW_RUNSC_SHA512" ||
    die runsc_install_failed "could not install gVisor $BW_RUNSC_VERSION"
  tar -xjf "$bundle" -C "$staged"
  for bin in runsc containerd-shim-runsc-v1; do
    [[ -f "$staged/$bin" ]] || die runsc_install_failed "gVisor bundle has no $bin"
    install -m 0755 "$staged/$bin" "$BIN_DIR/$bin"
  done
  write_containerd_runsc
  log info runsc_installed "gVisor $BW_RUNSC_VERSION installed, containerd runsc handler registered"
}

write_secret_file() {
  printf '%s' "$2" >"$1.tmp"
  chmod 0600 "$1.tmp"
  mv -f "$1.tmp" "$1"
}

new_token() {
  python3 -c 'import secrets; print(secrets.token_hex(32))'
}

write_unit() {
  local unit="$1" mode="$2"
  cat >"$UNIT_DIR/$unit.service" <<EOF
[Unit]
Description=Blackwing k3s $mode ($BW_POOL pool, $BW_K3S_VERSION)
Wants=network-online.target
After=network-online.target

[Service]
Type=notify
KillMode=process
Delegate=yes
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
TimeoutStartSec=0
Restart=always
RestartSec=5s
ExecStartPre=-/sbin/modprobe br_netfilter
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/local/bin/k3s $mode

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT_DIR/$unit.service"
}

unit_active() {
  systemctl is-active --quiet "$1"
}

start_unit() {
  systemctl daemon-reload
  systemctl enable "$1"
  systemctl start --no-block "$1"
  retry "start $1" unit_active "$1" || die join_failed "$1 did not become active; check journalctl -u $1"
}

# --- server ----------------------------------------------------------------------------------

server_tokens() {
  local server agent
  server="$(retry "read server join token" ssm_get "$BW_SSM_JOIN_TOKEN")" || die ssm_failed "cannot read the server join token"
  agent="$(retry "read agent join token" ssm_get "$BW_SSM_AGENT_TOKEN")" || die ssm_failed "cannot read the agent join token"
  if [[ "$server" == "$BW_TOKEN_PLACEHOLDER" ]]; then
    server="$(new_token)"
    write_secret_file "$K3S_ETC/server-token" "$server"
    retry "store server join token" ssm_put "$BW_SSM_JOIN_TOKEN" "$K3S_ETC/server-token" SecureString ||
      die ssm_failed "cannot store the server join token"
    log info token_generated "generated the server join token (first control-plane boot)"
  else
    write_secret_file "$K3S_ETC/server-token" "$server"
    log info token_reused "reusing the existing server join token"
  fi
  if [[ "$agent" == "$BW_TOKEN_PLACEHOLDER" ]]; then
    agent="$(new_token)"
    write_secret_file "$K3S_ETC/agent-token" "$agent"
    retry "store agent join token" ssm_put "$BW_SSM_AGENT_TOKEN" "$K3S_ETC/agent-token" SecureString ||
      die ssm_failed "cannot store the agent join token"
    log info token_generated "generated the agent join token"
  else
    write_secret_file "$K3S_ETC/agent-token" "$agent"
  fi
}

api_ready() {
  "$BIN_DIR/k3s" kubectl get --raw=/readyz >/dev/null 2>&1
}

publish_server() {
  local kubeconfig="$WORK/kubeconfig" version="$WORK/version"
  retry "API server ready" api_ready || die server_not_ready "k3s API server never became ready"
  printf '%s' "$(installed_k3s_version)" >"$version"
  retry "publish server version" ssm_put "$BW_SSM_SERVER_VERSION" "$version" String ||
    die ssm_failed "cannot publish the server version"
  if [[ -n "${BW_SSM_KUBECONFIG:-}" ]]; then
    sed "s#https://127.0.0.1:$BW_API_PORT#https://$BW_API_HOST:$BW_API_PORT#" "$K3S_ETC/k3s.yaml" >"$kubeconfig"
    chmod 0600 "$kubeconfig"
    retry "export kubeconfig" ssm_put "$BW_SSM_KUBECONFIG" "$kubeconfig" SecureString Advanced ||
      die ssm_failed "cannot export the kubeconfig"
    rm -f "$kubeconfig"
  fi
  log info server_ready "k3s server $BW_K3S_VERSION ready at https://$BW_API_HOST:$BW_API_PORT"
}

# --- agent -----------------------------------------------------------------------------------

# Pre-join drift check: the server must report exactly the pinned version (§8 #9).
server_version_matches() {
  local v
  v="$(ssm_get "$BW_SSM_SERVER_VERSION")" || return 1
  if [[ "$v" == "$BW_K3S_VERSION" ]]; then
    return 0
  fi
  log warn version_mismatch "server reports '$v' but this node is pinned to $BW_K3S_VERSION; not joining"
  return 1
}

agent_token_ready() {
  local t
  t="$(ssm_get "$BW_SSM_AGENT_TOKEN")" || return 1
  [[ -n "$t" && "$t" != "$BW_TOKEN_PLACEHOLDER" ]] || return 1
  write_secret_file "$K3S_ETC/agent-token" "$t"
}

# --- main ------------------------------------------------------------------------------------

log info bootstrap_start "k3s $BW_K3S_VERSION ${BW_NODE_ROLE} bootstrap (control-plane generation ${BW_CONTROL_PLANE_GENERATION:-n/a})"
retry "clock synchronisation" time_synced || die clock_unsynchronised "NTP never synchronised; TLS join would fail"
install_k3s
install_runsc

if [[ "$BW_NODE_ROLE" == "server" ]]; then
  [[ -n "${BW_SSM_JOIN_TOKEN:-}" ]] || die config_invalid "BW_SSM_JOIN_TOKEN is required on a server" 2
  server_tokens
  write_unit k3s server
  start_unit k3s
  publish_server
else
  retry "pre-join version check" server_version_matches ||
    die version_drift "server version never matched the pinned $BW_K3S_VERSION; refusing to join" 3
  retry "read agent join token" agent_token_ready || die ssm_failed "cannot read the agent join token"
  write_unit k3s-agent agent
  start_unit k3s-agent
  log info agent_joined "k3s agent active against https://$BW_API_HOST:$BW_API_PORT"
fi
