#!/usr/bin/env bash
# Blackwing dev-host bootstrap (DEVENV-001).
#
# Turns a fresh Ubuntu 24.04 host (AWS EC2, laptop or VM) into a Blackwing dev
# machine: Docker Engine + containerd, gVisor runsc registered as a Docker
# runtime, Node.js 22 + pnpm (corepack), Go, OpenTofu, kubectl, helm, mkcert
# and jq, all at the exact versions pinned in infra/versions.env.
#
# Idempotent: every step reads the installed version first and only acts on a
# missing or mismatched tool, so a second run changes nothing and exits 0.
# Every download is checksum-verified against versions.env before it is
# installed; Docker packages come from Docker's apt repository whose signing
# key fingerprint is pinned. The Docker socket is never mounted into any
# container, and --check reports any container that has it mounted.
#
# Usage:
#   infra/bootstrap.sh            install / reconcile, then verify
#   infra/bootstrap.sh --check    print expected vs actual versions; non-zero on drift
#   infra/bootstrap.sh --dry-run  show what would change; changes nothing, needs no sudo
#   infra/bootstrap.sh --help
#
# Out of scope: k3s + the gVisor RuntimeClass (DEVENV-014) and the compose dev
# stack (DEVENV-002+). No secrets are read or written here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Overrides exist for the self-tests (scripts/infra-bootstrap.test.mjs); a
# normal run uses the defaults.
VERSIONS_FILE="${BW_BOOTSTRAP_VERSIONS_FILE:-$SCRIPT_DIR/versions.env}"
ROOT="${BW_BOOTSTRAP_ROOT:-}"
OS_RELEASE_FILE="${BW_BOOTSTRAP_OS_RELEASE:-/etc/os-release}"
REPORT_FILE="${BW_BOOTSTRAP_REPORT:-$SCRIPT_DIR/.bootstrap-report.json}"
RETRIES="${BW_BOOTSTRAP_RETRIES:-5}"
RETRY_DELAY="${BW_BOOTSTRAP_RETRY_DELAY:-2}"

BIN_DIR="$ROOT/usr/local/bin"
OPT_DIR="$ROOT/usr/local/lib/blackwing"
DAEMON_JSON="$ROOT/etc/docker/daemon.json"
APT_KEYRING="$ROOT/etc/apt/keyrings/docker.asc"
APT_SOURCE="$ROOT/etc/apt/sources.list.d/docker.list"
# Paths as the host sees them (written into config files).
RUNSC_HOST_PATH="/usr/local/bin/runsc"
APT_KEYRING_HOST_PATH="/etc/apt/keyrings/docker.asc"

DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

MODE="install"
DRY_RUN=0
CHANGES=0
SUDO=()
ARCH=""
GVISOR_ARCH=""
NODE_ARCH=""
TMP_DIR=""
APT_UPDATED=0

# ----------------------------------------------------------------- logging --

log() { printf '[bootstrap] %s\n' "$*" >&2; }
step() { printf '\n[bootstrap] ==> %s\n' "$*" >&2; }
warn() { printf '[bootstrap] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

changed() {
  CHANGES=$((CHANGES + 1))
  if ((DRY_RUN)); then
    log "would change: $*"
  else
    log "changed: $*"
  fi
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

# Runs a privileged command (via sudo unless already root). In --dry-run it
# only logs the command.
priv() {
  if ((DRY_RUN)); then
    log "would run: $*"
    return 0
  fi
  "${SUDO[@]+"${SUDO[@]}"}" "$@"
}

# ---------------------------------------------------------------- preflight --

load_versions() {
  [[ -r "$VERSIONS_FILE" ]] || die "versions manifest not found: $VERSIONS_FILE"
  # shellcheck source=infra/versions.env
  source "$VERSIONS_FILE"
  local required=(DOCKER_VERSION CONTAINERD_VERSION DOCKER_BUILDX_VERSION DOCKER_COMPOSE_VERSION
    DOCKER_APT_SUITE DOCKER_GPG_FINGERPRINT RUNSC_VERSION NODE_VERSION PNPM_VERSION GO_VERSION
    TOFU_VERSION KUBECTL_VERSION HELM_VERSION MKCERT_VERSION JQ_VERSION HELLO_WORLD_IMAGE)
  local name
  for name in "${required[@]}"; do
    [[ -n "${!name:-}" ]] || die "versions manifest $VERSIONS_FILE does not pin $name"
  done
}

detect_os() {
  [[ -r "$OS_RELEASE_FILE" ]] || die "cannot read $OS_RELEASE_FILE; this script supports Ubuntu 24.04 LTS only"
  local id version_id
  id="$(sed -n 's/^ID=//p' "$OS_RELEASE_FILE" | tr -d '"')"
  version_id="$(sed -n 's/^VERSION_ID=//p' "$OS_RELEASE_FILE" | tr -d '"')"
  if [[ "$id" != "ubuntu" || "$version_id" != "24.04" ]]; then
    die "unsupported OS '${id:-unknown} ${version_id:-}': Blackwing dev hosts run Ubuntu 24.04 LTS (CONTEXT_PACK §10)"
  fi
  log "os: Ubuntu $version_id"
}

detect_arch() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64 | amd64)
      ARCH="amd64"
      GVISOR_ARCH="x86_64"
      NODE_ARCH="x64"
      ;;
    aarch64 | arm64)
      ARCH="arm64"
      GVISOR_ARCH="aarch64"
      NODE_ARCH="arm64"
      ;;
    *) die "unsupported CPU architecture '$machine': only x86_64 (amd64) and aarch64 (arm64) are supported" ;;
  esac
  log "arch: $machine -> $ARCH"
}

# Pinned checksum for <TOOL> on the detected arch, e.g. checksum_for NODE SHA256.
checksum_for() {
  local var="${1}_${2}_${ARCH^^}"
  printf '%s' "${!var:-}"
}

privileges_message() {
  cat >&2 <<'EOF'
[bootstrap] Required privileges (run as a normal user with sudo rights, or as root):
[bootstrap]   - apt-get install/update and apt-mark (Docker Engine, containerd, base packages)
[bootstrap]   - write /etc/apt/keyrings, /etc/apt/sources.list.d and /etc/docker/daemon.json
[bootstrap]   - write /usr/local/bin and /usr/local/lib/blackwing (pinned tool binaries)
[bootstrap]   - systemctl enable/restart docker
[bootstrap]   - usermod -aG docker <you>
EOF
}

setup_privileges() {
  if [[ "$(id -u)" == "0" ]]; then
    SUDO=()
    log "privileges: running as root"
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    privileges_message
    die "sudo is not installed and the script is not running as root"
  fi
  if sudo -n true >/dev/null 2>&1; then
    :
  elif [[ -t 0 ]]; then
    log "privileges: sudo needs your password"
    sudo -v || {
      privileges_message
      die "sudo authentication failed"
    }
  else
    privileges_message
    die "sudo needs a password but no terminal is attached (run interactively, or run 'sudo -v' first)"
  fi
  SUDO=(sudo)
  log "privileges: sudo ok"
}

check_kernel() {
  local release major minor
  release="$(uname -r)"
  major="${release%%.*}"
  minor="${release#*.}"
  minor="${minor%%[!0-9]*}"
  if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ ]]; then
    warn "cannot parse kernel release '$release'; gVisor needs Linux >= 4.14.77"
    return 0
  fi
  if ((major < 4 || (major == 4 && minor < 14))); then
    warn "kernel $release is too old for gVisor (runsc needs Linux >= 4.14.77)."
    warn "remediation: install the HWE kernel ('sudo apt-get install linux-generic-hwe-24.04') and reboot,"
    warn "or use an EC2 instance type running the stock Ubuntu 24.04 kernel."
    return 0
  fi
  if grep -qi microsoft /proc/version 2>/dev/null; then
    warn "WSL2 kernel detected: gVisor may not work here; if the runsc check fails use an Ubuntu 24.04 VM or EC2 host."
  fi
  log "kernel: $release"
}

# ---------------------------------------------------------------- downloads --

make_tmp() {
  if [[ -z "$TMP_DIR" ]]; then
    TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bw-bootstrap.XXXXXX")"
  fi
}

# download <url> <dest>: retries with exponential backoff.
download() {
  local url="$1" dest="$2" attempt=1 delay="$RETRY_DELAY"
  while true; do
    if curl -fsSL --connect-timeout 20 --retry 0 -o "$dest" "$url"; then
      return 0
    fi
    if ((attempt >= RETRIES)); then
      rm -f "$dest"
      die "download failed after $attempt attempts: $url"
    fi
    warn "download attempt $attempt/$RETRIES failed for $url; retrying in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# verify <file> <sha256|sha512> <expected> <label>: refuses unpinned or mismatched artifacts.
verify() {
  local file="$1" algo="$2" expected="$3" label="$4" actual
  [[ -n "$expected" ]] || die "no pinned $algo checksum for $label on $ARCH in $VERSIONS_FILE; refusing to install an unverified binary"
  case "$algo" in
    sha256) actual="$(sha256sum "$file" | cut -d' ' -f1)" ;;
    sha512) actual="$(sha512sum "$file" | cut -d' ' -f1)" ;;
    *) die "unknown checksum algorithm $algo" ;;
  esac
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$file"
    die "checksum mismatch for $label: expected $expected, got $actual (download discarded)"
  fi
  log "verified $algo for $label"
}

fetch_verified() {
  local url="$1" dest="$2" algo="$3" expected="$4" label="$5"
  log "downloading $label from $url"
  download "$url" "$dest"
  verify "$dest" "$algo" "$expected" "$label"
}

# ------------------------------------------------------- version detection --

first_line() { head -n1 | tr -d '\r'; }

dpkg_version() {
  local out
  out="$(dpkg-query -W -f='${Status}|${Version}' "$1" 2>/dev/null || true)"
  if [[ "$out" == "install ok installed|"* ]]; then
    printf '%s' "${out#*|}"
  fi
}

installed_version() {
  local tool="$1" out=""
  case "$tool" in
    docker-ce | docker-ce-cli | containerd.io | docker-buildx-plugin | docker-compose-plugin)
      out="$(dpkg_version "$tool")"
      ;;
    runsc)
      out="$(runsc --version 2>/dev/null | sed -n 's/^runsc version release-//p' | first_line || true)"
      ;;
    node)
      out="$(node --version 2>/dev/null | first_line | sed 's/^v//' || true)"
      ;;
    pnpm)
      out="$( (cd / && COREPACK_ENABLE_NETWORK=0 pnpm --version 2>/dev/null | first_line) || true)"
      ;;
    go)
      out="$(go version 2>/dev/null | first_line | awk '{print $3}' | sed 's/^go//' || true)"
      ;;
    tofu)
      out="$(tofu version 2>/dev/null | sed -n 's/^OpenTofu v//p' | first_line || true)"
      ;;
    kubectl)
      out="$(kubectl version --client 2>/dev/null | sed -n 's/^Client Version: v//p' | first_line || true)"
      ;;
    helm)
      out="$(helm version --short 2>/dev/null | first_line | sed -e 's/^v//' -e 's/+.*//' || true)"
      ;;
    mkcert)
      out="$(mkcert -version 2>/dev/null | first_line | sed 's/^v//' || true)"
      ;;
    jq)
      out="$(jq --version 2>/dev/null | first_line | sed 's/^jq-//' || true)"
      ;;
    *) die "unknown tool $tool" ;;
  esac
  printf '%s' "$out"
}

expected_version() {
  case "$1" in
    docker-ce | docker-ce-cli) printf '%s' "$DOCKER_VERSION" ;;
    containerd.io) printf '%s' "$CONTAINERD_VERSION" ;;
    docker-buildx-plugin) printf '%s' "$DOCKER_BUILDX_VERSION" ;;
    docker-compose-plugin) printf '%s' "$DOCKER_COMPOSE_VERSION" ;;
    runsc) printf '%s' "$RUNSC_VERSION" ;;
    node) printf '%s' "$NODE_VERSION" ;;
    pnpm) printf '%s' "$PNPM_VERSION" ;;
    go) printf '%s' "$GO_VERSION" ;;
    tofu) printf '%s' "$TOFU_VERSION" ;;
    kubectl) printf '%s' "$KUBECTL_VERSION" ;;
    helm) printf '%s' "$HELM_VERSION" ;;
    mkcert) printf '%s' "$MKCERT_VERSION" ;;
    jq) printf '%s' "$JQ_VERSION" ;;
    *) die "unknown tool $1" ;;
  esac
}

is_current() {
  local tool="$1" want have
  want="$(expected_version "$tool")"
  have="$(installed_version "$tool")"
  if [[ "$have" == "$want" ]]; then
    log "ok: $tool $have"
    return 0
  fi
  log "$tool: installed '${have:-none}', pinned '$want'"
  return 1
}

# --------------------------------------------------------- install helpers --

# install_tree <name> <version> <staged dir> <bin=relative/path>...
# Copies a verified, staged tree into /usr/local/lib/blackwing/<name>/<version>
# (atomically, with a .complete marker so a half-finished prior install is
# detected and redone), then points /usr/local/bin/<bin> at it.
install_tree() {
  local name="$1" version="$2" staged="$3"
  shift 3
  local dest="$OPT_DIR/$name/$version"
  if [[ ! -f "$dest/.complete" ]]; then
    priv rm -rf "$dest" "$dest.partial"
    priv mkdir -p "$OPT_DIR/$name" "$dest.partial"
    priv cp -a "$staged/." "$dest.partial/"
    priv touch "$dest.partial/.complete"
    priv mv "$dest.partial" "$dest"
    changed "$name $version installed to $dest"
  fi
  link_bins "$dest" "$@"
}

link_bins() {
  local dest="$1" spec bin rel
  shift
  priv mkdir -p "$BIN_DIR"
  for spec in "$@"; do
    bin="${spec%%=*}"
    rel="${spec#*=}"
    if [[ "$(readlink "$BIN_DIR/$bin" 2>/dev/null || true)" != "$dest/$rel" ]]; then
      priv ln -sfn "$dest/$rel" "$BIN_DIR/$bin"
      changed "linked $BIN_DIR/$bin -> $dest/$rel"
    fi
  done
}

# install_artifact <name> <version> <url> <algo> <expected> <kind: bin|tgz|txz|tbz2> <bin=path>...
install_artifact() {
  local name="$1" version="$2" url="$3" algo="$4" expected="$5" kind="$6"
  shift 6
  local dest="$OPT_DIR/$name/$version"
  if [[ -f "$dest/.complete" ]]; then
    link_bins "$dest" "$@"
    return 0
  fi
  if ((DRY_RUN)); then
    [[ -n "$expected" ]] || die "no pinned $algo checksum for $name on $ARCH in $VERSIONS_FILE"
    changed "$name $version would be downloaded from $url, verified ($algo) and installed to $dest"
    return 0
  fi
  make_tmp
  local file="$TMP_DIR/$name-$version.download" staged="$TMP_DIR/$name-$version.staged"
  fetch_verified "$url" "$file" "$algo" "$expected" "$name $version"
  rm -rf "$staged"
  mkdir -p "$staged"
  case "$kind" in
    bin)
      local first="${1#*=}"
      cp "$file" "$staged/$first"
      chmod 0755 "$staged/$first"
      ;;
    tgz) tar -xzf "$file" -C "$staged" ;;
    txz) tar -xJf "$file" -C "$staged" ;;
    tbz2) tar -xjf "$file" -C "$staged" ;;
    *) die "unknown artifact kind $kind" ;;
  esac
  install_tree "$name" "$version" "$staged" "$@"
}

apt_update_once() {
  if ((APT_UPDATED == 0)); then
    priv env DEBIAN_FRONTEND=noninteractive apt-get update -q
    APT_UPDATED=1
  fi
}

# ------------------------------------------------------------------- steps --

ensure_base_packages() {
  step "base packages"
  local missing=() cmd
  for cmd in curl gpg tar xz bzip2 sha256sum sha512sum; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if ((${#missing[@]} == 0)); then
    log "ok: base packages present"
    return 0
  fi
  log "missing commands: ${missing[*]}"
  apt_update_once
  priv env DEBIAN_FRONTEND=noninteractive apt-get install -y -q ca-certificates curl gnupg tar xz-utils bzip2 coreutils
  changed "base packages installed (${missing[*]})"
}

ensure_jq() {
  step "jq $JQ_VERSION"
  is_current jq && return 0
  install_artifact jq "$JQ_VERSION" \
    "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-${ARCH}" \
    sha256 "$(checksum_for JQ SHA256)" bin "jq=jq"
}

ensure_docker_repo() {
  local fpr
  if [[ -f "$APT_KEYRING" ]]; then
    fpr="$(gpg --show-keys --with-colons "$APT_KEYRING" 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')"
    if [[ "$fpr" == "$DOCKER_GPG_FINGERPRINT" ]]; then
      log "ok: docker apt key $fpr"
    else
      log "docker apt key fingerprint '${fpr:-none}' does not match the pinned $DOCKER_GPG_FINGERPRINT"
      fetch_docker_key
    fi
  else
    fetch_docker_key
  fi
  local line="deb [arch=${ARCH} signed-by=${APT_KEYRING_HOST_PATH}] https://download.docker.com/linux/ubuntu ${DOCKER_APT_SUITE} stable"
  if [[ "$(cat "$APT_SOURCE" 2>/dev/null || true)" != "$line" ]]; then
    if ((DRY_RUN == 0)); then
      make_tmp
      printf '%s\n' "$line" >"$TMP_DIR/docker.list"
      priv mkdir -p "$(dirname "$APT_SOURCE")"
      priv install -m 0644 "$TMP_DIR/docker.list" "$APT_SOURCE"
    fi
    changed "docker apt source written to $APT_SOURCE"
    APT_UPDATED=0
  fi
}

fetch_docker_key() {
  if ((DRY_RUN)); then
    changed "docker apt key would be fetched and checked against $DOCKER_GPG_FINGERPRINT"
    return 0
  fi
  make_tmp
  local key="$TMP_DIR/docker.asc" fpr
  download "https://download.docker.com/linux/ubuntu/gpg" "$key"
  fpr="$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')"
  if [[ "$fpr" != "$DOCKER_GPG_FINGERPRINT" ]]; then
    die "docker apt signing key fingerprint '${fpr:-none}' does not match the pinned $DOCKER_GPG_FINGERPRINT; refusing to trust it"
  fi
  priv mkdir -p "$(dirname "$APT_KEYRING")"
  priv install -m 0644 "$key" "$APT_KEYRING"
  changed "docker apt key installed ($fpr)"
}

ensure_docker() {
  step "docker engine $DOCKER_VERSION (containerd $CONTAINERD_VERSION)"
  local pkg want specs=() all_current=1
  for pkg in "${DOCKER_PACKAGES[@]}"; do
    is_current "$pkg" || all_current=0
  done
  if ((all_current)); then
    ensure_docker_service
    return 0
  fi
  ensure_docker_repo
  for pkg in "${DOCKER_PACKAGES[@]}"; do
    want="$(expected_version "$pkg")"
    specs+=("$pkg=$want")
  done
  apt_update_once
  priv env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades --allow-change-held-packages "${specs[@]}"
  priv apt-mark hold "${DOCKER_PACKAGES[@]}"
  changed "docker packages installed and held: ${specs[*]}"
  ensure_docker_service
}

ensure_docker_service() {
  if systemctl is-active --quiet docker 2>/dev/null; then
    log "ok: docker service active"
    return 0
  fi
  priv systemctl enable --now docker
  changed "docker service enabled and started"
}

ensure_runsc() {
  step "gVisor runsc $RUNSC_VERSION"
  is_current runsc && return 0
  install_artifact runsc "$RUNSC_VERSION" \
    "https://storage.googleapis.com/gvisor/releases/release/${RUNSC_VERSION}/${GVISOR_ARCH}/gvisor.tar.bz2" \
    sha512 "$(checksum_for RUNSC SHA512)" tbz2 \
    "runsc=runsc" "containerd-shim-runsc-v1=containerd-shim-runsc-v1"
}

# Registers runsc in /etc/docker/daemon.json, preserving every other key. Never
# adds a TCP listener or anything that would expose the Docker socket.
ensure_runsc_runtime() {
  step "docker runtime 'runsc'"
  local current="" merged
  if ((DRY_RUN)) && ! command -v jq >/dev/null 2>&1; then
    changed "runsc would be registered as a docker runtime in $DAEMON_JSON (docker restarted)"
    return 0
  fi
  if [[ -f "$DAEMON_JSON" ]]; then
    if ! jq -e . "$DAEMON_JSON" >/dev/null 2>&1; then
      die "$DAEMON_JSON is not valid JSON; fix it by hand (it is left untouched)"
    fi
    current="$(jq -r '.runtimes.runsc.path // empty' "$DAEMON_JSON")"
    merged="$(jq --arg p "$RUNSC_HOST_PATH" '.runtimes.runsc = {path: $p}' "$DAEMON_JSON")"
  else
    merged="$(jq -n --arg p "$RUNSC_HOST_PATH" '{runtimes: {runsc: {path: $p}}}')"
  fi
  if [[ "$current" == "$RUNSC_HOST_PATH" ]]; then
    log "ok: runsc runtime registered in $DAEMON_JSON"
    return 0
  fi
  if ((DRY_RUN == 0)); then
    make_tmp
    printf '%s\n' "$merged" >"$TMP_DIR/daemon.json"
    priv mkdir -p "$(dirname "$DAEMON_JSON")"
    priv install -m 0644 "$TMP_DIR/daemon.json" "$DAEMON_JSON"
    priv systemctl restart docker
  fi
  changed "runsc registered as a docker runtime in $DAEMON_JSON (docker restarted)"
}

ensure_node() {
  step "node $NODE_VERSION"
  is_current node && return 0
  local dir="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  install_artifact node "$NODE_VERSION" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${dir}.tar.xz" \
    sha256 "$(checksum_for NODE SHA256)" txz \
    "node=$dir/bin/node" "npm=$dir/bin/npm" "npx=$dir/bin/npx" "corepack=$dir/bin/corepack"
}

# pnpm comes from corepack (bundled with Node 22), which verifies the npm
# registry signature of the pnpm release it downloads.
ensure_pnpm() {
  step "pnpm $PNPM_VERSION (corepack)"
  is_current pnpm && return 0
  if ((DRY_RUN)); then
    changed "corepack would enable pnpm in $BIN_DIR and activate pnpm@$PNPM_VERSION"
    return 0
  fi
  priv corepack enable pnpm --install-directory "$BIN_DIR"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g "pnpm@${PNPM_VERSION}"
  changed "pnpm $PNPM_VERSION activated via corepack"
}

ensure_go() {
  step "go $GO_VERSION"
  is_current go && return 0
  install_artifact go "$GO_VERSION" \
    "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    sha256 "$(checksum_for GO SHA256)" tgz "go=go/bin/go" "gofmt=go/bin/gofmt"
}

ensure_tofu() {
  step "opentofu $TOFU_VERSION"
  is_current tofu && return 0
  install_artifact tofu "$TOFU_VERSION" \
    "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${ARCH}.tar.gz" \
    sha256 "$(checksum_for TOFU SHA256)" tgz "tofu=tofu"
}

ensure_kubectl() {
  step "kubectl $KUBECTL_VERSION"
  is_current kubectl && return 0
  install_artifact kubectl "$KUBECTL_VERSION" \
    "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
    sha256 "$(checksum_for KUBECTL SHA256)" bin "kubectl=kubectl"
}

ensure_helm() {
  step "helm $HELM_VERSION"
  is_current helm && return 0
  install_artifact helm "$HELM_VERSION" \
    "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${ARCH}.tar.gz" \
    sha256 "$(checksum_for HELM SHA256)" tgz "helm=linux-${ARCH}/helm"
}

ensure_mkcert() {
  step "mkcert $MKCERT_VERSION"
  is_current mkcert && return 0
  install_artifact mkcert "$MKCERT_VERSION" \
    "https://github.com/FiloSottile/mkcert/releases/download/v${MKCERT_VERSION}/mkcert-v${MKCERT_VERSION}-linux-${ARCH}" \
    sha256 "$(checksum_for MKCERT SHA256)" bin "mkcert=mkcert"
}

target_user() {
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    printf '%s' "$SUDO_USER"
  else
    id -un
  fi
}

ensure_docker_group() {
  step "docker group membership"
  local user
  user="$(target_user)"
  if [[ "$user" == "root" ]]; then
    log "ok: running as root, no docker group change needed"
    return 0
  fi
  if [[ " $(id -nG "$user") " == *" docker "* ]]; then
    log "ok: $user is in the docker group"
  else
    priv usermod -aG docker "$user"
    changed "$user added to the docker group"
  fi
  if [[ " $(id -nG) " != *" docker "* ]]; then
    warn "docker group membership is not active in this shell yet."
    warn "log out and back in (or run 'newgrp docker') before using docker without sudo."
  fi
}

# docker command usable by this shell: plain docker if the daemon is reachable,
# otherwise via sudo (fresh group membership not active yet).
docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  elif ((${#SUDO[@]})); then
    "${SUDO[@]}" docker "$@"
  else
    docker "$@"
  fi
}

# Lists running containers that have a Docker/containerd socket mounted.
socket_exposures() {
  local ids
  ids="$(docker_cmd ps -q 2>/dev/null || true)"
  [[ -n "$ids" ]] || return 0
  # shellcheck disable=SC2086 # word splitting of container ids is intended
  docker_cmd inspect --format '{{.Name}}{{range .Mounts}} {{.Source}}{{end}}' $ids 2>/dev/null |
    awk '/(docker|containerd)\.sock/ {sub(/^\//, "", $1); print $1}' || true
}

RUNSC_HELLO=""
verify_runsc_hello() {
  if ((DRY_RUN)); then
    log "would run: docker run --rm --runtime=runsc $HELLO_WORLD_IMAGE"
    RUNSC_HELLO="skipped (dry-run)"
    return 0
  fi
  if docker_cmd run --rm --runtime=runsc --network=none "$HELLO_WORLD_IMAGE" >/dev/null 2>&1; then
    RUNSC_HELLO="ok"
    log "ok: hello-world ran under the runsc runtime"
  else
    RUNSC_HELLO="failed"
    warn "docker run --runtime=runsc hello-world failed."
    warn "remediation: check 'runsc --version', that $DAEMON_JSON lists runsc and docker was restarted,"
    warn "and that the kernel supports gVisor (Linux >= 4.14.77; WSL2 and some nested VMs do not)."
  fi
}

# ------------------------------------------------------------ report/check --

ROWS=()
DRIFT=0
add_row() {
  local name="$1" want="$2" have="$3" status
  if [[ "$have" == "$want" ]]; then
    status="OK"
  elif [[ -z "$have" ]]; then
    status="MISSING"
    DRIFT=1
  else
    status="DRIFT"
    DRIFT=1
  fi
  ROWS+=("$name|$want|${have:-}|$status")
}

collect_rows() {
  ROWS=()
  DRIFT=0
  local tool
  for tool in "${DOCKER_PACKAGES[@]}" runsc node pnpm go tofu kubectl helm mkcert jq; do
    add_row "$tool" "$(expected_version "$tool")" "$(installed_version "$tool")"
  done
  local runtime=""
  if [[ -f "$DAEMON_JSON" ]] && command -v jq >/dev/null 2>&1; then
    runtime="$(jq -r '.runtimes.runsc.path // empty' "$DAEMON_JSON" 2>/dev/null || true)"
  fi
  add_row "docker runtime runsc" "$RUNSC_HOST_PATH" "$runtime"
  local exposed
  exposed="$(socket_exposures | paste -sd, - || true)"
  add_row "docker.sock mounts" "none" "${exposed:-none}"
  if [[ "$MODE" == "check" ]]; then
    verify_runsc_hello
  fi
  if [[ "$RUNSC_HELLO" != "skipped (dry-run)" ]]; then
    add_row "runsc hello-world" "ok" "$RUNSC_HELLO"
  fi
}

print_table() {
  local row name want have status
  printf '\n%-22s %-34s %-34s %s\n' "TOOL" "EXPECTED" "ACTUAL" "STATUS"
  for row in "${ROWS[@]}"; do
    IFS='|' read -r name want have status <<<"$row"
    printf '%-22s %-34s %-34s %s\n' "$name" "$want" "${have:--}" "$status"
  done
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

write_report() {
  ((DRY_RUN)) && return 0
  local row name want have status first=1 out
  out="{\n  \"generatedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\n  \"mode\": \"$MODE\",\n  \"arch\": \"$ARCH\",\n  \"changes\": $CHANGES,\n  \"ok\": $([[ $DRIFT == 0 ]] && echo true || echo false),\n  \"tools\": ["
  for row in "${ROWS[@]}"; do
    IFS='|' read -r name want have status <<<"$row"
    ((first)) || out+=","
    first=0
    out+="\n    {\"name\": \"$(json_escape "$name")\", \"expected\": \"$(json_escape "$want")\", \"actual\": \"$(json_escape "$have")\", \"status\": \"$status\"}"
  done
  out+="\n  ]\n}\n"
  if printf '%b' "$out" >"$REPORT_FILE" 2>/dev/null; then
    log "report written to $REPORT_FILE"
  else
    warn "could not write $REPORT_FILE"
  fi
}

# --------------------------------------------------------------------- main --

parse_args() {
  while (($#)); do
    case "$1" in
      --check) MODE="check" ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown argument: $1"
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  load_versions
  export PATH="$BIN_DIR:$PATH"
  detect_arch

  if [[ "$MODE" == "check" ]]; then
    collect_rows
    print_table
    write_report
    if ((DRIFT)); then
      die "toolchain drift detected (see table); run infra/bootstrap.sh to reconcile"
    fi
    log "check passed: every tool matches infra/versions.env"
    return 0
  fi

  detect_os
  if ((DRY_RUN)); then
    log "dry-run: nothing will be changed"
  else
    setup_privileges
  fi
  check_kernel

  ensure_base_packages
  ensure_jq
  ensure_docker
  ensure_runsc
  ensure_runsc_runtime
  ensure_node
  ensure_pnpm
  ensure_go
  ensure_tofu
  ensure_kubectl
  ensure_helm
  ensure_mkcert
  ensure_docker_group

  step "verify"
  verify_runsc_hello
  if ((DRY_RUN)); then
    log "dry-run complete: $CHANGES change(s) would be made"
    return 0
  fi
  collect_rows
  print_table
  write_report
  if ((DRIFT)); then
    die "bootstrap finished with drift or a failed verification (see table above)"
  fi
  log "bootstrap complete: $CHANGES change(s)"
}

# Sourcing the file (for smoke tests) defines the functions without running main.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
