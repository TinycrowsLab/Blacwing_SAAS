#!/bin/sh
# bw-proxy (IMAGE-007, #605): runs a proxy-unaware tool under proxychains-ng so every TCP connection and every
# DNS name goes through the egress gateway's SOCKS5 port. The proxychains launcher is a separate GPL-2.0 process
# under /opt/bw/tools/lib, never on PATH. Fails closed: no gateway, a malformed gateway or a gateway that is
# down all stop the tool. It never connects directly.
#   bw-proxy <tool> [args...]
set -eu

# Install-time constants (infra/docker/sandbox Dockerfile). The test suite rewrites PC_HOME for a local build.
PC_HOME=/opt/bw/tools/lib/proxychains-ng
TEMPLATE=/etc/bw/proxychains.conf
EX_UNAVAILABLE=69
EX_USAGE=64

fail() {
  echo "bw-proxy: $*" >&2
  exit "$1"
}

[ "$#" -ge 1 ] || fail "$EX_USAGE" "usage: bw-proxy <tool> [args...]"

# Nested call: this process already runs under proxychains (its preload library is loaded), so exec the tool
# directly instead of wrapping it twice.
case ":${LD_PRELOAD:-}:" in
  *:*/libproxychains4.so:*) exec "$@" ;;
esac

[ -r "$TEMPLATE" ] || fail "$EX_UNAVAILABLE" "missing config template $TEMPLATE; refusing to run"
[ -x "$PC_HOME/bin/proxychains4" ] || fail "$EX_UNAVAILABLE" "proxychains-ng is not installed; refusing to run"

url=${ALL_PROXY:-${all_proxy:-}}
[ -n "$url" ] || fail "$EX_UNAVAILABLE" "ALL_PROXY is not set; refusing to run without the egress gateway"
case "$url" in
  socks5://* | socks5h://*) ;;
  *) fail "$EX_UNAVAILABLE" "ALL_PROXY must be a socks5:// or socks5h:// URL" ;;
esac
hostport=${url#*://}
# Hostname or IPv4 plus a port only: no userinfo, no IPv6 literal, no whitespace or newline that could alter the config.
case "$hostport" in
  *[!A-Za-z0-9.:-]* | '') fail "$EX_UNAVAILABLE" "ALL_PROXY gateway must be host:port (hostname or IPv4)" ;;
esac
printf '%s' "$hostport" | grep -Eq '^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$' \
  || fail "$EX_UNAVAILABLE" "ALL_PROXY gateway must be host:port (hostname or IPv4)"
host=${hostport%:*}
port=${hostport##*:}
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] 2>/dev/null \
  || fail "$EX_UNAVAILABLE" "ALL_PROXY port is out of range"

# Private, per-call config in the writable tmpfs. The file holds no secrets but is still 0600.
conf=$(mktemp)
trap 'rm -f "$conf"' EXIT
chmod 600 "$conf"
sed -e "s/@GATEWAY_HOST@/$host/" -e "s/@GATEWAY_PORT@/$port/" "$TEMPLATE" > "$conf"

# Not exec: the EXIT trap removes the rendered config after the tool finishes.
"$PC_HOME/bin/proxychains4" -f "$conf" -- "$@"
