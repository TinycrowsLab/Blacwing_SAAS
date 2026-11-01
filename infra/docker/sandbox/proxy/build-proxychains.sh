#!/bin/sh
# Builds the pinned proxychains-ng (IMAGE-007, #605) for the bw-sandbox proxychains stage.
# Reads the "proxychains" entry of tools.pin.json, downloads the release source over HTTPS, verifies its
# sha256 before anything is unpacked, builds it and installs only the launcher and the preload library under
# <prefix> (bin/ and lib/). Any mismatch aborts the build (supply-chain guard). Runs as root in the builder stage.
#   sh build-proxychains.sh <tools.pin.json> <prefix>
set -eu

pin="${1:?usage: build-proxychains.sh <tools.pin.json> <prefix>}"
prefix="${2:?usage: build-proxychains.sh <tools.pin.json> <prefix>}"

fail() {
  echo "build-proxychains: $*" >&2
  exit 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).proxychains;
if (!p) throw new Error("no proxychains entry");
console.log([p.name, p.version, p.url, p.sha256].join(" "));' "$pin" > "$work/pin.txt" \
  || fail "cannot read the proxychains pin from $pin"
read -r name version url sha < "$work/pin.txt"

archive="$work/$name-$version.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o "$archive" "$url" \
  || fail "download failed for $name $version ($url)"
printf '%s  %s\n' "$sha" "$archive" | sha256sum -c --status - \
  || fail "sha256 mismatch for $name $version; refusing to build"

tar -xzf "$archive" -C "$work"
src="$work/proxychains-ng-$version"
[ -d "$src" ] || fail "unexpected archive layout for $name $version"

# Only the launcher and the preload library are installed. PREFIX keeps everything under the tools tree;
# SYSCONFDIR is /etc/bw so no stray /etc/proxychains.conf is written (bw-proxy renders its own config).
make -C "$src" PREFIX="$prefix" SYSCONFDIR=/etc/bw >/dev/null \
  || fail "make failed for $name $version"
make -C "$src" PREFIX="$prefix" SYSCONFDIR=/etc/bw install-libs install-tools >/dev/null \
  || fail "make install failed for $name $version"

"$prefix/bin/proxychains4" -h >/dev/null 2>&1 || fail "$name did not run after install"
echo "build-proxychains: $name $version ok"
