#!/usr/bin/env bash
# Blackwing dev k3s (DEVENV-014).
#
# Provisions a single-node k3s on the dev host with the gVisor `runsc` runtime
# registered in containerd and a `gvisor` RuntimeClass, installs Helm, applies
# the sandbox namespace, admission guard, default-deny NetworkPolicy and dev
# placeholders (infra/k3s/manifests), writes a kubeconfig with context
# `bw-dev`, then runs infra/k3s/verify.sh, which proves the isolation
# properties with probe pods. Everything is pinned (infra/versions.env +
# infra/k3s/versions.env) and every download is sha256-verified.
#
# The host Docker/containerd socket is never mounted into any workload: the
# sandbox admission guard rejects every hostPath volume in sandbox namespaces.
#
# Usage:
#   infra/k3s/install-dev.sh              install / reconcile k3s, then verify
#   infra/k3s/install-dev.sh --k3d        hosts without gVisor: k3s-in-Docker via k3d
#                                         (runc handler; gVisor check reported NOT VERIFIED)
#   infra/k3s/install-dev.sh --check      health check only; non-zero on failure
#   infra/k3s/install-dev.sh --dry-run    show what would change; changes nothing
#   infra/k3s/install-dev.sh --no-verify  skip the verify.sh probes
#   infra/k3s/install-dev.sh --help
#
# Prerequisite: infra/bootstrap.sh (DEVENV-001) for runsc, kubectl and helm pins.
# Needs >= K3S_MIN_CPUS CPUs and K3S_MIN_MEM_MB MiB RAM. Small laptops: set
# BW_K3S_SKIP=1 and use the Docker + runsc sandbox driver instead.
#
# Environment: BW_K3S_KUBECONFIG (default ~/.kube/blackwing-dev.yaml).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Overrides exist for the self-tests (scripts/k3s-dev.test.mjs).
HOST_VERSIONS_FILE="${BW_K3S_HOST_VERSIONS_FILE:-$SCRIPT_DIR/../versions.env}"
VERSIONS_FILE="${BW_K3S_VERSIONS_FILE:-$SCRIPT_DIR/versions.env}"
ROOT="${BW_K3S_ROOT:-}"
MEMINFO="${BW_K3S_MEMINFO:-/proc/meminfo}"
PROC_VERSION="${BW_K3S_PROC_VERSION:-/proc/version}"
KUBECONFIG_OUT="${BW_K3S_KUBECONFIG:-$HOME/.kube/blackwing-dev.yaml}"
READY_TIMEOUT="${BW_K3S_READY_TIMEOUT:-180s}"
USER_BIN="${BW_K3S_USER_BIN:-$HOME/.local/bin}"

BIN_DIR="$ROOT/usr/local/bin"
K3S_CONFIG="$ROOT/etc/rancher/k3s/config.yaml"
K3S_KUBECONFIG="$ROOT/etc/rancher/k3s/k3s.yaml"
CONTAINERD_TMPL="$ROOT/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl"
UNIT_FILE="$ROOT/etc/systemd/system/k3s.service"
CONTEXT="bw-dev"

MODE="install"
DRY_RUN=0
K3D=0
VERIFY=1
CHANGES=0
RESTART=0
SUDO=()
ARCH=""
TMP_DIR=""

log() { printf '[k3s-dev] %s\n' "$*" >&2; }
step() { printf '\n[k3s-dev] ==> %s\n' "$*" >&2; }
warn() { printf '[k3s-dev] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[k3s-dev] ERROR: %s\n' "$*" >&2
  exit 1
}
changed() {
  CHANGES=$((CHANGES + 1))
  if ((DRY_RUN)); then log "would change: $*"; else log "changed: $*"; fi
}
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; }
cleanup() { if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then rm -rf "$TMP_DIR"; fi; }
trap cleanup EXIT

priv() {
  if ((DRY_RUN)); then
    log "would run: $*"
    return 0
  fi
  "${SUDO[@]+"${SUDO[@]}"}" "$@"
}

kc() { kubectl --kubeconfig "$KUBECONFIG_OUT" --context "$CONTEXT" "$@"; }

# ---------------------------------------------------------------- preflight --

load_versions() {
  local f
  for f in "$HOST_VERSIONS_FILE" "$VERSIONS_FILE"; do
    [[ -r "$f" ]] || die "versions manifest not found: $f"
    # shellcheck source=/dev/null
    source "$f"
  done
  local name
  for name in RUNSC_VERSION HELM_VERSION K3S_VERSION K3S_IMAGE K3S_PAUSE_IMAGE K3D_CLUSTER PROBE_IMAGE \
    K3S_MIN_CPUS K3S_MIN_MEM_MB; do
    [[ -n "${!name:-}" ]] || die "versions manifests do not pin $name"
  done
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) ARCH="amd64" ;;
    aarch64 | arm64) ARCH="arm64" ;;
    *) die "unsupported architecture '$(uname -m)': k3s dev hosts are x86_64 or aarch64" ;;
  esac
}

skip_message() {
  log "remediation: set BW_K3S_SKIP=1 and use the Docker + runsc sandbox driver (DockerDriver) for local e2e;"
  log "see docs/runbooks/dev-k3s.md 'Skipping the k3s path'."
}

check_resources() {
  local cpus mem_kb mem_mb
  cpus="$(nproc)"
  mem_kb="$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' "$MEMINFO" 2>/dev/null || true)"
  [[ "$mem_kb" =~ ^[0-9]+$ ]] || die "cannot read MemTotal from $MEMINFO"
  mem_mb=$((mem_kb / 1024))
  if ((cpus < K3S_MIN_CPUS || mem_mb < K3S_MIN_MEM_MB)); then
    printf '[k3s-dev] ERROR: host has %s CPUs / %s MiB RAM; the k3s path needs >= %s CPUs and >= %s MiB.\n' \
      "$cpus" "$mem_mb" "$K3S_MIN_CPUS" "$K3S_MIN_MEM_MB" >&2
    skip_message
    exit 1
  fi
  log "resources: $cpus CPUs, $mem_mb MiB RAM"
}

check_kernel() {
  local release major minor patch rest
  release="$(uname -r)"
  major="${release%%.*}"
  rest="${release#*.}"
  minor="${rest%%[!0-9]*}"
  rest="${rest#"$minor"}"
  rest="${rest#.}"
  patch="${rest%%[!0-9]*}"
  patch="${patch:-0}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] ||
    die "cannot parse kernel release '$release'; gVisor needs Linux >= 4.14.77"
  if ((major < 4 || (major == 4 && minor < 14) || (major == 4 && minor == 14 && patch < 77))); then
    printf '[k3s-dev] ERROR: kernel %s lacks gVisor support (runsc needs Linux >= 4.14.77).\n' "$release" >&2
    log "remediation: install the HWE kernel ('sudo apt-get install linux-generic-hwe-24.04') and reboot,"
    log "re-run infra/bootstrap.sh (DEVENV-001), or use --k3d / BW_K3S_SKIP=1 on this host."
    exit 1
  fi
  if grep -qi microsoft "$PROC_VERSION" 2>/dev/null; then
    printf '[k3s-dev] ERROR: WSL2 kernel detected (%s): gVisor + k3s is not supported here.\n' "$release" >&2
    log "remediation: run this on an Ubuntu 24.04 VM or EC2 dev host, or use 'install-dev.sh --k3d'"
    log "(runc handler, gVisor reported NOT VERIFIED) or BW_K3S_SKIP=1 (Docker + runsc driver)."
    exit 1
  fi
  log "kernel: $release"
}

check_runsc() {
  local bin out
  for bin in runsc containerd-shim-runsc-v1; do
    command -v "$bin" >/dev/null 2>&1 ||
      die "$bin not found on PATH: run infra/bootstrap.sh (DEVENV-001) to install gVisor $RUNSC_VERSION"
  done
  out="$(runsc --version 2>/dev/null | sed -n 's/^runsc version release-//p' | head -n 1 || true)"
  [[ "$out" == "$RUNSC_VERSION" ]] ||
    die "runsc version '${out:-unknown}' does not match the pin $RUNSC_VERSION: re-run infra/bootstrap.sh"
  log "runsc: $out"
}

check_privileges() {
  ((DRY_RUN)) && return 0
  if [[ "$(id -u)" == "0" ]]; then
    SUDO=()
  elif sudo -n true 2>/dev/null; then
    SUDO=(sudo)
  else
    die "root or passwordless sudo is required to install k3s (try 'sudo -v' first), or use --k3d"
  fi
}

check_network_policy_enabled() {
  local f
  for f in "$K3S_CONFIG" "$SCRIPT_DIR/host/config.yaml"; do
    if [[ -f "$f" ]] && grep -Eq "^[[:space:]]*disable-network-policy[[:space:]]*:[[:space:]]*[\"']?true" "$f"; then
      die "$f sets disable-network-policy: sandbox NetworkPolicy would not be enforced; remove it (docs/runbooks/dev-k3s.md)"
    fi
  done
}

# ---------------------------------------------------------------- downloads --

fetch_verified() {
  local url="$1" out="$2" expected="$3" what="$4" actual
  [[ -n "$expected" ]] || die "no pinned sha256 for $what on $ARCH"
  curl -fsSL --retry 5 --retry-delay 2 -o "$out" "$url" || die "download failed: $url"
  actual="$(sha256sum "$out" | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || die "checksum mismatch for $what: expected $expected, got $actual"
}

make_tmp() { [[ -n "$TMP_DIR" ]] || TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bw-k3s.XXXXXX")"; }

arch_pin() {
  local var="$1_${ARCH^^}"
  printf '%s' "${!var:-}"
}

# Installs $1 (repo file) as $2 with mode $3 when the content differs.
install_file() {
  local src="$1" dest="$2" mode="$3"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
    log "ok: $dest"
    return 0
  fi
  changed "$dest"
  RESTART=1
  priv mkdir -p "$(dirname "$dest")"
  priv install -m "$mode" "$src" "$dest"
}

ensure_k3s_binary() {
  step "k3s $K3S_VERSION"
  local current asset url
  current="$("$BIN_DIR/k3s" --version 2>/dev/null | sed -n 's/^k3s version \([^ ]*\).*/\1/p' | head -n 1 || true)"
  if [[ "$current" == "$K3S_VERSION" ]]; then
    log "ok: k3s $current"
    return 0
  fi
  asset="k3s"
  [[ "$ARCH" == "arm64" ]] && asset="k3s-arm64"
  url="https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION//+/%2B}/$asset"
  changed "k3s ${current:-missing} -> $K3S_VERSION ($url)"
  RESTART=1
  ((DRY_RUN)) && return 0
  make_tmp
  fetch_verified "$url" "$TMP_DIR/k3s" "$(arch_pin K3S_SHA256)" "k3s $K3S_VERSION"
  priv install -m 0755 "$TMP_DIR/k3s" "$BIN_DIR/k3s"
}

ensure_helm() {
  step "helm $HELM_VERSION"
  local current url
  current="$(helm version --template '{{.Version}}' 2>/dev/null || true)"
  if [[ "$current" == "v$HELM_VERSION" ]]; then
    log "ok: helm $current"
    return 0
  fi
  url="https://get.helm.sh/helm-v${HELM_VERSION}-linux-${ARCH}.tar.gz"
  changed "helm ${current:-missing} -> v$HELM_VERSION ($url)"
  ((DRY_RUN)) && return 0
  make_tmp
  fetch_verified "$url" "$TMP_DIR/helm.tgz" "$(arch_pin HELM_SHA256)" "helm $HELM_VERSION"
  tar -xzf "$TMP_DIR/helm.tgz" -C "$TMP_DIR"
  if ((K3D)); then
    # k3d mode runs without root: install for the current user only.
    mkdir -p "$USER_BIN"
    install -m 0755 "$TMP_DIR/linux-$ARCH/helm" "$USER_BIN/helm"
    hash -r
    [[ "$(helm version --template '{{.Version}}' 2>/dev/null || true)" == "v$HELM_VERSION" ]] ||
      die "helm v$HELM_VERSION installed to $USER_BIN but another helm comes first on PATH"
  else
    priv install -m 0755 "$TMP_DIR/linux-$ARCH/helm" "$BIN_DIR/helm"
  fi
}

# -------------------------------------------------------------------- k3s ----

start_k3s() {
  step "k3s service"
  if ((RESTART)); then
    priv systemctl daemon-reload
    priv systemctl enable k3s
    priv systemctl restart k3s
    changed "k3s service (re)started"
  else
    priv systemctl enable --now k3s
  fi
}

write_kubeconfig() {
  step "kubeconfig $KUBECONFIG_OUT (context $CONTEXT)"
  ((DRY_RUN)) && {
    log "would write $KUBECONFIG_OUT with context $CONTEXT"
    return 0
  }
  mkdir -p "$(dirname "$KUBECONFIG_OUT")"
  local i
  for ((i = 0; i < 60; i++)); do
    priv test -s "$K3S_KUBECONFIG" && break
    sleep 2
  done
  (
    umask 077
    priv cat "$K3S_KUBECONFIG" >"$KUBECONFIG_OUT"
  )
  chmod 0600 "$KUBECONFIG_OUT"
  kubectl --kubeconfig "$KUBECONFIG_OUT" config rename-context default "$CONTEXT" >/dev/null 2>&1 || true
}

check_runsc_handler() {
  step "containerd runtime handler 'runsc'"
  ((DRY_RUN)) && return 0
  local info
  info="$(priv "$BIN_DIR/k3s" crictl info 2>/dev/null || true)"
  if ! jq -e '[.. | objects | select(has("runsc"))] | length > 0' >/dev/null 2>&1 <<<"$info"; then
    printf '[k3s-dev] ERROR: runsc is not registered with k3s containerd.\n' >&2
    log "remediation: check $CONTAINERD_TMPL exists, containerd-shim-runsc-v1 is on root's PATH,"
    log "then 'sudo systemctl restart k3s' and 'sudo k3s crictl info | jq .config.containerd.runtimes'."
    exit 1
  fi
  log "ok: runsc handler registered"
}

wait_ready() {
  step "node Ready"
  ((DRY_RUN)) && return 0
  kc wait --for=condition=Ready node --all --timeout="$READY_TIMEOUT" >/dev/null ||
    die "k3s node not Ready after $READY_TIMEOUT: 'sudo journalctl -u k3s -n 200'"
  log "ok: node Ready"
}

apply_manifests() {
  step "Blackwing manifests"
  if ((DRY_RUN)); then
    log "would apply $SCRIPT_DIR/manifests$( ((K3D)) && printf ' + k3d/runtimeclass-runc.yaml')"
    return 0
  fi
  local f
  for f in "$SCRIPT_DIR"/manifests/*.yaml; do
    if ((K3D)) && [[ "$(basename "$f")" == "00-runtimeclass.yaml" ]]; then
      f="$SCRIPT_DIR/k3d/runtimeclass-runc.yaml"
    fi
    kc apply -f "$f" >/dev/null || die "kubectl apply failed for $f"
  done
  local ns
  for ns in bw-system bw-dev-outside; do
    kc -n "$ns" rollout status deploy --timeout="$READY_TIMEOUT" >/dev/null ||
      die "dev placeholders in $ns not ready: kubectl -n $ns get pods; kubectl -n $ns describe pods"
  done
  log "ok: manifests applied"
}

# -------------------------------------------------------------------- k3d ----

ensure_k3d_cluster() {
  step "k3d cluster $K3D_CLUSTER ($K3S_IMAGE)"
  command -v k3d >/dev/null 2>&1 || die "k3d not found on PATH (download the pinned release into ~/.local/bin)"
  command -v docker >/dev/null 2>&1 || die "docker not found: --k3d runs k3s inside Docker"
  if k3d cluster list "$K3D_CLUSTER" >/dev/null 2>&1; then
    log "ok: cluster $K3D_CLUSTER exists"
  else
    changed "k3d cluster $K3D_CLUSTER"
    ((DRY_RUN)) && return 0
    # OFFLINE-STUB(online-porting #886): runc handler on k3d; the real dev host runs k3s + gVisor runsc.
    k3d cluster create "$K3D_CLUSTER" --image "$K3S_IMAGE" --servers 1 --agents 0 \
      --api-port 127.0.0.1:16443 --no-lb --wait --timeout 180s \
      --kubeconfig-update-default=false \
      --k3s-arg "--kubelet-arg=pod-max-pids=512@server:*" \
      --k3s-arg "--secrets-encryption@server:*" \
      --k3s-arg "--disable=traefik@server:*" >/dev/null || die "k3d cluster create failed"
  fi
  ((DRY_RUN)) && return 0
  mkdir -p "$(dirname "$KUBECONFIG_OUT")"
  (
    umask 077
    k3d kubeconfig get "$K3D_CLUSTER" >"$KUBECONFIG_OUT"
  )
  chmod 0600 "$KUBECONFIG_OUT"
  kubectl --kubeconfig "$KUBECONFIG_OUT" config rename-context "k3d-$K3D_CLUSTER" "$CONTEXT" >/dev/null 2>&1 || true
}

# Imports the pinned images into the k3d node's containerd from the host, so
# the node never needs registry access of its own (its Docker network may have
# none) and digest-pinned references still resolve: crane keeps the full OCI
# index, so the stored digest equals the pin.
preload_k3d_images() {
  step "preload images into k3d"
  ((DRY_RUN)) && return 0
  if ! command -v crane >/dev/null 2>&1; then
    warn "crane not found: the k3d node will pull images itself (needs registry access from Docker)"
    return 0
  fi
  local node="k3d-$K3D_CLUSTER-server-0" ref name tag
  make_tmp
  for ref in "$PROBE_IMAGE" "$K3S_PAUSE_IMAGE"; do
    name="${ref%@*}"
    [[ "$name" == */* ]] || name="library/$name"
    [[ "$name" == *.*/* ]] || name="docker.io/$name"
    tag="$TMP_DIR/image-$RANDOM"
    crane pull --format=oci "$ref" "$tag" >/dev/null || die "crane pull failed for $ref"
    tar -C "$tag" -cf "$tag.tar" .
    docker cp "$tag.tar" "$node:/tmp/bw-image.tar" >/dev/null
    docker exec "$node" ctr -n k8s.io images import --all-platforms --index-name "$name" /tmp/bw-image.tar >/dev/null ||
      die "importing $ref into $node failed"
    docker exec "$node" rm -f /tmp/bw-image.tar
    log "ok: $ref"
  done
}

# ------------------------------------------------------------------ check ----

run_check() {
  local fail=0
  step "health check (context $CONTEXT, $KUBECONFIG_OUT)"
  if kc get nodes -o jsonpath='{range .items[*]}{.status.nodeInfo.kubeletVersion}{"\n"}{end}' 2>/dev/null |
    grep -q .; then
    log "ok: API reachable"
  else
    warn "API not reachable"
    fail=1
  fi
  if [[ "$(kc get runtimeclass gvisor -o jsonpath='{.handler}' 2>/dev/null || true)" =~ ^(runsc|runc)$ ]]; then
    log "ok: runtimeclass gvisor"
  else
    warn "runtimeclass gvisor missing"
    fail=1
  fi
  helm version --template '{{.Version}}' >/dev/null 2>&1 || {
    warn "helm missing"
    fail=1
  }
  return "$fail"
}

main() {
  while (($#)); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --check) MODE="check" ;;
      --k3d) K3D=1 ;;
      --no-verify) VERIFY=0 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
  if [[ "${BW_K3S_SKIP:-0}" == "1" ]]; then
    log "BW_K3S_SKIP=1: skipping the k3s path; local sandboxes use the Docker + runsc driver."
    exit 0
  fi
  load_versions
  detect_arch
  if [[ "$MODE" == "check" ]]; then
    run_check
    exit $?
  fi
  check_resources
  if ((K3D)); then
    ensure_k3d_cluster
  else
    check_kernel
    check_runsc
    check_network_policy_enabled
    check_privileges
    step "k3s config"
    install_file "$SCRIPT_DIR/host/config.yaml" "$K3S_CONFIG" 0600
    install_file "$SCRIPT_DIR/host/config-v3.toml.tmpl" "$CONTAINERD_TMPL" 0600
    install_file "$SCRIPT_DIR/host/k3s.service" "$UNIT_FILE" 0644
    ensure_k3s_binary
    start_k3s
    write_kubeconfig
  fi
  wait_ready
  if ((K3D)); then preload_k3d_images; else check_runsc_handler; fi
  ensure_helm
  apply_manifests
  if ((DRY_RUN)); then
    log "dry run: $CHANGES change(s) pending"
    exit 0
  fi
  if ((VERIFY)); then
    local args=(--kubeconfig "$KUBECONFIG_OUT" --context "$CONTEXT")
    ((K3D)) && args+=(--k3d)
    "$SCRIPT_DIR/verify.sh" "${args[@]}"
  fi
  log "done: export KUBECONFIG=$KUBECONFIG_OUT; kubectl config use-context $CONTEXT"
}

main "$@"
