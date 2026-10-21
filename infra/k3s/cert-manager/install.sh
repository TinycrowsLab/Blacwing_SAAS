#!/usr/bin/env bash
# OFFLINE-STUB(online-porting #896): validated offline with helm template; live Let's Encrypt issuance happens in the porting issue.
# Install cert-manager (pinned) and the bw-ingress release (INFRA-012).
#
#   infra/k3s/cert-manager/install.sh --domain D --email E --zone-id Z [--prod] [--renewal-drill]
#                                     [--namespace bw-system] [--dry-run]
#
# Order matters: cert-manager (CRDs) first, then bw-ingress (ClusterIssuers, Certificates,
# Traefik middlewares and routes). Staging issuance is the default; --prod needs an explicit flag
# so iteration never burns Let's Encrypt production rate limits. --dry-run renders the manifests
# with `helm template` and applies nothing (no cluster, no network).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART="$HERE/../../helm/bw-ingress"
# shellcheck source=versions.env
source "$HERE/versions.env"

DOMAIN="" EMAIL="" ZONE="" NS="bw-system" PROD=0 DRILL=0 DRY=0
while (($#)); do
  case "$1" in
    --domain) DOMAIN="$2"; shift ;;
    --email) EMAIL="$2"; shift ;;
    --zone-id) ZONE="$2"; shift ;;
    --namespace) NS="$2"; shift ;;
    --prod) PROD=1 ;;
    --renewal-drill) DRILL=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '[cert-manager] ERROR: unknown argument %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

die() {
  printf '[cert-manager] ERROR: %s\n' "$*" >&2
  exit 2
}
[[ -n "$DOMAIN" && -n "$EMAIL" && -n "$ZONE" ]] || die "--domain, --email and --zone-id are required"
((PROD && DRILL)) && die "--renewal-drill is a staging drill and cannot be combined with --prod"

VALUES=(-f "$CHART/values.yaml")
((PROD)) && VALUES+=(-f "$CHART/values-prod.yaml")
((DRILL)) && VALUES+=(-f "$CHART/values-renewal-drill.yaml")
SET=(--set "domain=$DOMAIN" --set "acme.email=$EMAIL" --set "acme.route53.hostedZoneID=$ZONE")

if ((DRY)); then
  helm template bw-ingress "$CHART" --namespace "$NS" "${VALUES[@]}" "${SET[@]}"
  exit 0
fi

helm repo add jetstack "$CERT_MANAGER_CHART_REPO" >/dev/null
helm upgrade --install "$CERT_MANAGER_RELEASE" jetstack/cert-manager \
  --namespace "$CERT_MANAGER_NAMESPACE" --create-namespace \
  --version "$CERT_MANAGER_CHART_VERSION" \
  -f "$HERE/values.yaml" --atomic --wait
kubectl label namespace "$CERT_MANAGER_NAMESPACE" \
  pod-security.kubernetes.io/enforce=restricted --overwrite
helm upgrade --install bw-ingress "$CHART" --namespace "$NS" --create-namespace \
  "${VALUES[@]}" "${SET[@]}" --atomic --wait
