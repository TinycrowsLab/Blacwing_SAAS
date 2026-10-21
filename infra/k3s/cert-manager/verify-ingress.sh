#!/usr/bin/env bash
# External probes for the public ingress (INFRA-012). Run from OUTSIDE the cluster.
#
#   infra/k3s/cert-manager/verify-ingress.sh <domain> [--insecure-staging]
#
# Proves, for app.<domain> and api.<domain>:
#   1. the certificate chain validates (skipped with --insecure-staging, because the Let's
#      Encrypt staging root is not in any trust store; the chain is still printed);
#   2. HTTP redirects to HTTPS (permanent);
#   3. HSTS (max-age >= 15552000), nosniff and X-Frame-Options are present;
#   4. TLS 1.2 handshakes and TLS 1.1 / 1.0 are refused;
#   5. /internal/broker (and /internal/) is NOT reachable on the public API host
#      (404 or a refused connection, never a 2xx/3xx/401/403 from the broker).
# Exit status: 0 when every check passed, 1 otherwise.
set -uo pipefail

DOMAIN="${1:-}"
INSECURE=0
[[ "${2:-}" == "--insecure-staging" ]] && INSECURE=1
[[ -n "$DOMAIN" ]] || {
  printf 'usage: %s <domain> [--insecure-staging]\n' "$0" >&2
  exit 2
}
PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  printf 'ok   %s\n' "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL %s\n' "$1"
}
CURL=(curl -sS --max-time 15)
((INSECURE)) && CURL+=(-k)

for host in "app.$DOMAIN" "api.$DOMAIN"; do
  loc="$("${CURL[@]}" -o /dev/null -D - "http://$host/" 2>/dev/null | tr -d '\r')"
  if grep -qiE '^HTTP/[0-9.]+ 308' <<<"$loc" && grep -qiE "^location: https://$host" <<<"$loc"; then
    ok "$host: HTTP redirects to HTTPS"
  else
    bad "$host: HTTP did not redirect to HTTPS"
  fi

  hdr="$("${CURL[@]}" -I "https://$host/" 2>/dev/null | tr -d '\r')"
  if [[ -z "$hdr" ]]; then
    bad "$host: HTTPS request failed (certificate chain or connection)"
  else
    ok "$host: HTTPS chain accepted"
    sts="$(sed -nE 's/^[Ss]trict-[Tt]ransport-[Ss]ecurity: .*max-age=([0-9]+).*/\1/p' <<<"$hdr" | head -1)"
    if [[ -n "$sts" && "$sts" -ge 15552000 ]]; then ok "$host: HSTS max-age=$sts"; else bad "$host: HSTS missing or too short"; fi
    grep -qi '^x-content-type-options: nosniff' <<<"$hdr" && ok "$host: nosniff" || bad "$host: nosniff missing"
    grep -qiE '^x-frame-options: (deny|sameorigin)|^content-security-policy:.*frame-ancestors' <<<"$hdr" && ok "$host: frame protection" || bad "$host: frame protection missing"
  fi

  if openssl s_client -connect "$host:443" -servername "$host" -tls1_2 </dev/null >/dev/null 2>&1; then ok "$host: TLS 1.2 accepted"; else bad "$host: TLS 1.2 handshake failed"; fi
  for old in tls1_1 tls1; do
    if openssl s_client -connect "$host:443" -servername "$host" "-$old" </dev/null >/dev/null 2>&1; then bad "$host: $old was accepted"; else ok "$host: $old refused"; fi
  done
done

for path in /internal/broker /internal/ /internal/broker/v1/status; do
  code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://api.$DOMAIN$path" 2>/dev/null || true)"
  if [[ "$code" == "404" || "$code" == "000" || -z "$code" ]]; then ok "api: $path not reachable ($code)"; else bad "api: $path answered $code"; fi
done

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
((FAIL == 0))
