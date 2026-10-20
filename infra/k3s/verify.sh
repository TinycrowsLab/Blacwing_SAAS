#!/usr/bin/env bash
# Blackwing dev k3s isolation probes (DEVENV-014).
#
# Proves, with real pods instead of prose, that the dev cluster enforces the
# §4.1 / ADR-0011 sandbox contract:
#   1. cluster healthy, helm available, RuntimeClass gvisor -> handler runsc;
#   2. the sample sandbox Pod runs under gVisor (dmesg/uname from inside);
#   3. it runs non-root, read-only rootfs, zero effective capabilities,
#      no-new-privileges, seccomp, tmpfs /workspace, resource limits;
#   4. egress reaches ONLY egress gateway / model gateway / Run Broker; the
#      metadata endpoint (IPv4 and IPv6), the internet, the Kubernetes API, the
#      node and any other namespace are blocked, while an unrestricted control
#      pod can reach the same "outside" service (so the block is the policy);
#   5. the host Docker/containerd socket is neither mountable (admission rejects
#      every hostPath) nor present nor reachable from a sandbox Pod.
#
# Usage: infra/k3s/verify.sh [--kubeconfig FILE] [--context NAME] [--k3d] [--keep]
#   --k3d   k3d substitute cluster (runc handler): the gVisor checks are
#           reported NOT VERIFIED and never counted as passed.
#   --keep  leave the sample sandbox Pod running afterwards.
# Exit status: 0 when every check passed, 1 otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBECONFIG_FILE="${BW_K3S_KUBECONFIG:-$HOME/.kube/blackwing-dev.yaml}"
CONTEXT="bw-dev"
K3D=0
KEEP=0
TIMEOUT="${BW_K3S_READY_TIMEOUT:-180s}"
PASS=0
FAIL=0
UNVERIFIED=0
POD="sandbox-example"
NS="sandbox"
SOCKETS=(/var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/k3s/containerd/containerd.sock)

while (($#)); do
  case "$1" in
    --kubeconfig)
      KUBECONFIG_FILE="$2"
      shift
      ;;
    --context)
      CONTEXT="$2"
      shift
      ;;
    --k3d) K3D=1 ;;
    --keep) KEEP=1 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '[verify] ERROR: unknown argument %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

kc() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" "$@"; }
pass() {
  PASS=$((PASS + 1))
  printf '[verify] PASS  %s\n' "$*"
}
fail() {
  FAIL=$((FAIL + 1))
  printf '[verify] FAIL  %s\n' "$*"
}
unverified() {
  UNVERIFIED=$((UNVERIFIED + 1))
  printf '[verify] NOT VERIFIED  %s\n' "$*"
}
check() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}
check_not() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "$what"; else pass "$what"; fi
}
in_sandbox() { kc -n "$NS" exec "$POD" -c session -- sh -c "$1"; }
# Fetch http://HOST:PORT/hostname from inside the sandbox (3 s timeout).
sandbox_get() { in_sandbox "wget -q -T 3 -O /dev/null 'http://$1/hostname'"; }
cluster_ip() { kc -n "$1" get svc "$2" -o jsonpath='{.spec.clusterIP}'; }

cleanup() { ((KEEP)) || kc -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ------------------------------------------------------ 1. cluster basics ----
check "API reachable and every node Ready" kc wait --for=condition=Ready node --all --timeout=60s
check "helm available" helm version --template '{{.Version}}'
handler="$(kc get runtimeclass gvisor -o jsonpath='{.handler}' 2>/dev/null || true)"
if [[ "$handler" == "runsc" ]]; then
  pass "runtimeclass gvisor -> handler runsc"
elif ((K3D)) && [[ "$handler" == "runc" ]]; then
  # OFFLINE-STUB(online-porting #886): gVisor is proven only on a real k3s + runsc dev host.
  unverified "runtimeclass gvisor uses the k3d runc substitute (gVisor needs the real dev host)"
else
  fail "runtimeclass gvisor missing or wrong handler '${handler:-none}'"
fi
check "sandbox admission guard bound" kc get validatingadmissionpolicybinding blackwing-sandbox-guard
check "default-deny NetworkPolicy present" kc -n "$NS" get networkpolicy default-deny-all

# --------------------------------------------- 5a. admission (server dry-run) --
# A minimal, otherwise-compliant sandbox pod; each case breaks one rule.
hostile() {
  local name="$1" extra_spec="$2" extra_ctr="${3:-}" volumes="${4:-}" rc="${5-  runtimeClassName: gvisor}"
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $name
  namespace: $NS
spec:
$rc
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
$extra_spec
  containers:
    - name: c
      image: $(sed -n 's/^PROBE_IMAGE="\(.*\)"$/\1/p' "$SCRIPT_DIR/versions.env")
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      resources:
        limits:
          cpu: 100m
          memory: 32Mi
$extra_ctr
$volumes
EOF
}
dry_run() { kc apply --dry-run=server -f - <<<"$1"; }
check "control: a compliant sandbox pod passes admission (dry-run)" dry_run "$(hostile probe-ok '')"
for sock in "${SOCKETS[@]}"; do
  check_not "admission rejects hostPath mount of $sock" dry_run "$(hostile probe-sock '' \
    "      volumeMounts:
        - name: sock
          mountPath: /sock" \
    "  volumes:
    - name: sock
      hostPath:
        path: $sock")"
done
check_not "admission rejects hostPath of the whole host root" dry_run "$(hostile probe-root-fs '' '' \
  "  volumes:
    - name: host
      hostPath:
        path: /")"
check_not "admission rejects a pod without runtimeClassName gvisor" dry_run "$(hostile probe-norc '' '' '' '')"
check_not "admission rejects hostNetwork" dry_run "$(hostile probe-hostnet '  hostNetwork: true')"
check_not "admission rejects a root container" dry_run "$(hostile probe-root '' \
  "      env: []" '' "  runtimeClassName: gvisor
  hostPID: false" | sed 's/runAsUser: 65532/runAsUser: 0/; s/runAsNonRoot: true/runAsNonRoot: false/')"
check_not "admission rejects a writable root filesystem" dry_run "$(hostile probe-rw '' |
  sed 's/readOnlyRootFilesystem: true/readOnlyRootFilesystem: false/')"

# --------------------------------------------------- start the sample pod ----
aliases="  hostAliases:"
for pair in bw-system/egress-gateway bw-system/model-gateway bw-system/run-broker bw-dev-outside/outside-http; do
  ip="$(cluster_ip "${pair%/*}" "${pair#*/}" 2>/dev/null || true)"
  [[ -n "$ip" ]] || {
    fail "service $pair not found (apply infra/k3s/manifests)"
    continue
  }
  aliases+=$'\n'"    - ip: \"$ip\""$'\n'"      hostnames: [\"${pair#*/}\"]"
done
kc -n "$NS" delete pod "$POD" --ignore-not-found --wait=true >/dev/null 2>&1 || true
manifest="$(awk -v a="$aliases" '/^  hostNetwork: false$/ { print a } { print }' "$SCRIPT_DIR/examples/sandbox-pod.yaml")"
if kc apply -f - <<<"$manifest" >/dev/null && kc -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout="$TIMEOUT" >/dev/null; then
  pass "sample sandbox pod admitted and Running"
else
  fail "sample sandbox pod did not start: kubectl -n $NS describe pod $POD"
  printf '[verify] summary: %s passed, %s failed, %s not verified\n' "$PASS" "$FAIL" "$UNVERIFIED"
  exit 1
fi

# ---------------------------------------------------------------- 2. gVisor --
kernel="$(in_sandbox 'uname -a' 2>/dev/null || true)"
printf '[verify] sandbox uname: %s\n' "$kernel"
if in_sandbox 'dmesg 2>/dev/null' 2>/dev/null | grep -qi 'gvisor'; then
  pass "sandbox runs under gVisor (dmesg shows the gVisor kernel)"
elif ((K3D)); then
  unverified "gVisor kernel inside the sandbox (k3d substitute runs runc)"
else
  fail "dmesg inside the sandbox does not show gVisor: the pod is not running under runsc"
fi

# --------------------------------------------------------- 3. hardening ------
check "runs non-root (uid 65532)" in_sandbox "[ \"\$(id -u)\" = 65532 ]"
check_not "root filesystem is read-only" in_sandbox 'touch /probe-rootfs'
check "effective capabilities are empty" in_sandbox "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status"
check "no-new-privileges set" in_sandbox "! grep -q '^NoNewPrivs' /proc/self/status || grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status"
check "workspace is a writable tmpfs" in_sandbox "grep -Eq ' /workspace tmpfs ' /proc/mounts && touch /workspace/probe"
check "no service-account token mounted" in_sandbox '[ ! -e /var/run/secrets/kubernetes.io/serviceaccount/token ]'
spec="$(kc -n "$NS" get pod "$POD" -o jsonpath='{.spec.securityContext.seccompProfile.type} {.spec.containers[0].securityContext.allowPrivilegeEscalation} {.spec.containers[0].securityContext.capabilities.drop[0]} {.spec.containers[0].resources.limits.cpu} {.spec.containers[0].resources.limits.memory}')"
if [[ "$spec" == "RuntimeDefault false ALL 500m 256Mi" ]]; then
  pass "seccomp RuntimeDefault, allowPrivilegeEscalation=false, drop ALL, cpu/memory limits"
else
  fail "pod spec hardening drifted: '$spec'"
fi

# ----------------------------------------------------------- 4. egress -------
check "egress allowed: egress gateway (13128)" sandbox_get egress-gateway:13128
check "egress allowed: model gateway (13500)" sandbox_get model-gateway:13500
check "egress allowed: Run Broker API (13400)" sandbox_get run-broker:13400
check_not "egress blocked: cloud metadata 169.254.169.254" sandbox_get 169.254.169.254
check_not "egress blocked: cloud metadata IPv6 [fd00:ec2::254]" sandbox_get '[fd00:ec2::254]'
check_not "egress blocked: internet 1.1.1.1" sandbox_get 1.1.1.1:80
check_not "egress blocked: internet IPv6 [2606:4700:4700::1111]" sandbox_get '[2606:4700:4700::1111]:80'
check_not "egress blocked: another namespace (outside-http)" sandbox_get outside-http:18080
check_not "egress blocked: Kubernetes API" in_sandbox "wget -q -T 3 -O /dev/null --no-check-certificate https://$(cluster_ip default kubernetes):443/"
node_ip="$(kc get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
check_not "egress blocked: node kubelet $node_ip:10250" in_sandbox "wget -q -T 3 -O /dev/null --no-check-certificate https://$node_ip:10250/"
check_not "egress blocked: node Docker API $node_ip:2375" sandbox_get "$node_ip:2375"
outside_ip="$(cluster_ip bw-dev-outside outside-http)"
check "control: an unrestricted pod reaches outside-http (so the block above is the policy)" \
  kc -n bw-dev-outside exec deploy/outside-http -- wget -q -T 3 -O /dev/null "http://$outside_ip:18080/hostname"

# ------------------------------------------------- 5b. host socket in pod ----
for sock in "${SOCKETS[@]}"; do
  check_not "host socket $sock is absent inside the sandbox" in_sandbox "[ -e $sock ]"
done
check_not "no container-runtime socket anywhere under /run or /var/run" \
  in_sandbox "find /run /var/run -name '*.sock' 2>/dev/null | grep -q ."

printf '[verify] summary: %s passed, %s failed, %s not verified\n' "$PASS" "$FAIL" "$UNVERIFIED"
((FAIL == 0))
