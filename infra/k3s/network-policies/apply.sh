#!/usr/bin/env bash
# Apply the INFRA-011 NetworkPolicies in the safe order: default-deny first, then allows.
# Usage: apply.sh [--kubeconfig FILE] [--context NAME]
#        apply.sh --render-run RUN_ID      # print the per-run isolation policy
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "--render-run" ]]; then
  [[ "${2:-}" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || { echo "invalid run id" >&2; exit 2; }
  sed "s/__RUN_ID__/$2/g" "$HERE/run-isolation.template.yaml"
  exit 0
fi
args=()
while (($#)); do
  case "$1" in
    --kubeconfig) args+=(--kubeconfig "$2"); shift 2 ;;
    --context) args+=(--context "$2"); shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
for f in 00-default-deny.yaml 10-bw-system-apps.yaml 20-run-broker.yaml 30-sandbox.yaml; do
  kubectl "${args[@]}" apply -f "$HERE/$f"
done
