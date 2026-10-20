#!/usr/bin/env bash
# Trusted local TLS for the dev stack (DEVENV-013, #167).
#
#   infra/compose/tls/setup-tls.sh [--force] [--print-hosts]
#
# Installs the mkcert local CA into the system/browser trust stores (`mkcert -install`) and issues ONE
# wildcard certificate for *.bw.localhost into the git-ignored ./certs directory (override with BW_TLS_DIR).
# Re-running is a no-op while the certificate is valid for more than 30 days; --force (or an expired cert)
# regenerates it. The mkcert CA private key stays in mkcert's CAROOT and is never copied or committed;
# only the public CA certificate is exported (certs/rootCA.pem) for NODE_EXTRA_CA_CERTS in CI/headless runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${BW_TLS_DIR:-$here/certs}"
cert="$out/bw-localhost.pem"
key="$out/bw-localhost-key.pem"
renew_before_seconds=$((30 * 24 * 3600))
domain="bw.localhost"
# The wildcard covers app/api/auth/juice/... (one label). The apex and loopback IPs are listed explicitly.
names=("*.${domain}" "${domain}" "127.0.0.1" "::1")
hostnames=(app api auth juice)

force=0
print_hosts=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --print-hosts) print_hosts=1 ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "setup-tls: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

hosts_line() {
  local line="127.0.0.1 ${domain}" h
  for h in "${hostnames[@]}"; do line+=" ${h}.${domain}"; done
  printf '%s\n' "$line"
}

if [ "$print_hosts" = 1 ]; then
  hosts_line
  exit 0
fi

if ! command -v mkcert >/dev/null 2>&1; then
  echo "setup-tls: mkcert not found. Run infra/bootstrap.sh (installs a pinned mkcert) or install it from https://github.com/FiloSottile/mkcert" >&2
  exit 1
fi

umask 077
mkdir -p "$out"

if ! mkcert -install; then
  echo "setup-tls: warning: 'mkcert -install' could not update every trust store (headless/CI?)." >&2
  echo "           Trust the CA manually or export NODE_EXTRA_CA_CERTS=${out}/rootCA.pem for Node-based clients." >&2
fi

if [ "$force" = 0 ] && [ -s "$cert" ] && [ -s "$key" ] &&
  openssl x509 -checkend "$renew_before_seconds" -noout -in "$cert" >/dev/null 2>&1; then
  echo "setup-tls: certificate still valid for more than 30 days (use --force to regenerate): $cert"
else
  mkcert -cert-file "$cert" -key-file "$key" "${names[@]}"
  chmod 600 "$key"
  chmod 644 "$cert"
  echo "setup-tls: wrote $cert and $key"
fi

# Public CA certificate only. `rootCA-key.pem` must never leave CAROOT.
caroot="$(mkcert -CAROOT)"
if [ -s "$caroot/rootCA.pem" ]; then
  cp "$caroot/rootCA.pem" "$out/rootCA.pem"
  chmod 644 "$out/rootCA.pem"
fi

if ! getent hosts "app.${domain}" >/dev/null 2>&1; then
  echo "setup-tls: app.${domain} does not resolve on this machine. Add this line to /etc/hosts (needs root):" >&2
  hosts_line >&2
fi

echo "setup-tls: done. Start the proxy with: pnpm dev:tls"
