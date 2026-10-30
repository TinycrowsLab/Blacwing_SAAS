#!/bin/sh
# Installs the pinned ProjectDiscovery tools (IMAGE-002, #600) for the bw-sandbox tools stage.
# Reads tools.pin.json, downloads each release archive over HTTPS, verifies its sha256 before anything
# is extracted, extracts only the named binary and checks that it reports the pinned version. Any
# mismatch aborts the build (supply-chain guard). Runs as root in the builder stage only.
#   sh install-tools.sh <tools.pin.json> <bin-dir>
set -eu

pin="${1:?usage: install-tools.sh <tools.pin.json> <bin-dir>}"
bin="${2:?usage: install-tools.sh <tools.pin.json> <bin-dir>}"

fail() {
  echo "install-tools: $*" >&2
  exit 1
}

[ "$(uname -m)" = x86_64 ] || fail "pinned assets are linux/amd64 only; this host is $(uname -m)"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$bin"

node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const t of p.tools) console.log([t.name, t.version, t.url, t.sha256].join(" "));' "$pin" \
  > "$work/tools.txt" || fail "cannot read $pin"

while read -r name version url sha; do
  archive="$work/$name.zip"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o "$archive" "$url" \
    || fail "download failed for $name $version ($url)"
  printf '%s  %s\n' "$sha" "$archive" | sha256sum -c --status - \
    || fail "sha256 mismatch for $name $version; refusing to install"
  unzip -q -o -j "$archive" "$name" -d "$bin" || fail "$name binary missing from its release archive"
  chmod 0555 "$bin/$name"
  out=$("$bin/$name" -version 2>&1) || fail "$name -version failed"
  case "$out" in
    *"$version"*) ;;
    *) fail "$name does not report pinned version $version" ;;
  esac
  echo "install-tools: $name $version ok"
done < "$work/tools.txt"
