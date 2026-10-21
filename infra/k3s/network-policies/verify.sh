#!/usr/bin/env bash
# Live enforcement check for the INFRA-011 NetworkPolicies (needs a cluster that has the
# dev placeholders from ../manifests/40-dev-placeholders.yaml and the policies applied).
# Real denies, not "kubectl get netpol": every negative probe must actually fail.
# Usage: verify.sh [--kubeconfig FILE] [--context NAME] [--regression]
#   --regression  also delete default-deny-all, prove the probes then DETECT open egress,
#                 and restore it (guards against tests that pass without enforcement).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KC=()
REGRESSION=0
while (($#)); do
  case "$1" in
    --kubeconfig) KC+=(--kubeconfig "$2"); shift 2 ;;
    --context) KC+=(--context "$2"); shift 2 ;;
    --regression) REGRESSION=1; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
kc() { kubectl "${KC[@]}" "$@"; }
IMG="$(sed -n 's/^PROBE_IMAGE="\(.*\)"$/\1/p' "$HERE/../versions.env")"
fails=0
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fails=$((fails + 1)); }

# probe NS NAME LABELS URL -> 0 when the URL answered
probe() {
  local ns="$1" name="$2" labels="$3" url="$4"
  kc -n "$ns" delete pod "$name" --ignore-not-found --wait >/dev/null 2>&1
  kc -n "$ns" run "$name" --image="$IMG" --restart=Never --labels="$labels" --rm -i --quiet \
    --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"p","image":"'"$IMG"'","command":["wget","-q","-T","4","-O","/dev/null","'"$url"'"],"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}}]}}' \
    >/dev/null 2>&1
}
expect_open() { if probe "$@"; then ok "reachable: $5"; else bad "should be reachable: $5"; fi; }
expect_blocked() { if probe "$@"; then bad "should be BLOCKED: $5"; else ok "blocked: $5"; fi; }

SB="blackwing.io/component=sandbox,blackwing.io/run=run-a"
GW="egress-gateway.bw-system.svc:13128"
MG="model-gateway.bw-system.svc:13500"
BR="run-broker.bw-system.svc:13400"

run_matrix() {
  expect_open sandbox np-gw "$SB" "http://$GW/hostname"
  expect_open sandbox np-mg "$SB" "http://$MG/hostname"
  expect_open sandbox np-br "$SB" "http://$BR/hostname"
  expect_blocked sandbox np-net "$SB" "http://1.1.1.1"
  expect_blocked sandbox np-imds "$SB" "http://169.254.169.254/latest/meta-data/"
  expect_blocked sandbox np-imds6 "$SB" "http://[fd00:ec2::254]/"
  expect_blocked sandbox np-outside "$SB" "http://outside.bw-dev-outside.svc/hostname"
  expect_blocked sandbox np-badlabel "blackwing.io/component=sandbxo" "http://$GW/hostname"
  expect_blocked bw-dev-outside np-nonsandbox "app=intruder" "http://$BR/hostname"
  # cross-run: a second run's pod is the target
  kc -n sandbox delete pod np-run-b --ignore-not-found --wait >/dev/null 2>&1
  kc -n sandbox run np-run-b --image="$IMG" --restart=Never \
    --labels="blackwing.io/component=sandbox,blackwing.io/run=run-b" \
    --overrides='{"spec":{"automountServiceAccountToken":false,"containers":[{"name":"p","image":"'"$IMG"'","command":["httpd","-f","-p","8080","-h","/etc"]}]}}' >/dev/null 2>&1
  kc -n sandbox wait --for=condition=Ready pod/np-run-b --timeout=60s >/dev/null 2>&1
  ip="$(kc -n sandbox get pod np-run-b -o jsonpath='{.status.podIP}' 2>/dev/null)"
  [[ -n "$ip" ]] && expect_blocked sandbox np-cross "$SB" "http://$ip:8080/hostname" || bad "cross-run target pod did not start"
  kc -n sandbox delete pod np-run-b --ignore-not-found >/dev/null 2>&1
}

kc -n sandbox get networkpolicy default-deny-all >/dev/null 2>&1 || bad "default-deny-all missing in sandbox"
kc -n bw-system get networkpolicy default-deny-all >/dev/null 2>&1 || bad "default-deny-all missing in bw-system"
run_matrix

if ((REGRESSION)); then
  echo "-- regression: remove default-deny-all, expect the probes to detect open egress"
  kc -n sandbox delete networkpolicy default-deny-all >/dev/null 2>&1
  kc -n sandbox delete networkpolicy sandbox-egress >/dev/null 2>&1
  if probe sandbox np-reg "$SB" "http://outside.bw-dev-outside.svc/hostname"; then
    ok "regression guard: open egress detected after policy removal"
  else
    bad "regression guard: egress still blocked without policies (test is not exercising enforcement)"
  fi
  kc apply -f "$HERE/00-default-deny.yaml" >/dev/null && kc apply -f "$HERE/30-sandbox.yaml" >/dev/null
fi

((fails)) && { echo "$fails check(s) failed"; exit 1; }
echo "all network policy checks passed"
