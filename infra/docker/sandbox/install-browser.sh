#!/bin/sh
# Installs the pinned headless Chromium and fonts into bw-sandbox (IMAGE-005, #603). Runs as root in the runtime
# stage during the image build only. It refuses any version that differs from tools.pin.json, installs the pinned
# Debian font packages, installs the Chromium build that the pinned playwright-core downloads (chromium only) into
# the root-owned /opt/bw/browsers, and launches that Chromium headless as bw as a smoke test. Nothing downloads at
# runtime. Chromium runs with Playwright's default `--no-sandbox` because the container, not Chromium's own
# namespace sandbox, is the isolation boundary (runsc + the hardened container, SANDBOX-007).
#   sh install-browser.sh <tools.pin.json> <app-dir>
set -eu

pin="${1:?usage: install-browser.sh <tools.pin.json> <app-dir>}"
app="${2:?usage: install-browser.sh <tools.pin.json> <app-dir>}"
browsers=/opt/bw/browsers

fail() {
  echo "install-browser: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "must run as root during the image build"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const b = p.browser;
console.log(["playwright", b.playwright].join(" "));
console.log(["playwrightMcp", b.playwrightMcp].join(" "));
console.log(["chromiumVersion", b.chromium.version].join(" "));
console.log(["chromiumRevision", b.chromium.revision].join(" "));
for (const f of p.fonts) console.log(["font", f.package + "=" + f.version].join(" "));' "$pin" \
  > "$work/pins.txt" || fail "cannot read $pin"

pin_of() {
  value=$(awk -v k="$1" '$1 == k { print $2 }' "$work/pins.txt")
  [ -n "$value" ] || fail "tools.pin.json has no $1"
  printf '%s' "$value"
}
pw=$(pin_of playwright)
pwmcp=$(pin_of playwrightMcp)
chromium_version=$(pin_of chromiumVersion)
revision=$(pin_of chromiumRevision)
fonts=$(awk '$1 == "font" { print $2 }' "$work/pins.txt")

# The installed playwright-core and @playwright/mcp must be the pinned pair the agent runtime checks at launch.
installed_pw=$(node -p "require('$app/node_modules/playwright-core/package.json').version") \
  || fail "playwright-core is not installed under $app"
[ "$installed_pw" = "$pw" ] || fail "playwright-core $installed_pw is not the pinned $pw"
installed_mcp=$(node -p "require('$app/node_modules/@playwright/mcp/package.json').version") \
  || fail "@playwright/mcp is not installed under $app"
[ "$installed_mcp" = "$pwmcp" ] || fail "@playwright/mcp $installed_mcp is not the pinned $pwmcp"

# Pinned Debian font packages first (exact versions), so the browser's dependency install keeps them as they are.
# Word splitting over $fonts is intended: each entry is a package=version pair.
apt-get update
# shellcheck disable=SC2086
apt-get install -y --no-install-recommends $fonts

mkdir -p "$browsers"
PLAYWRIGHT_BROWSERS_PATH="$browsers" \
  node "$app/node_modules/playwright-core/cli.js" install --with-deps chromium \
  || fail "playwright install chromium failed"
[ -d "$browsers/chromium-$revision" ] || fail "chromium revision $revision was not installed"
chmod -R a+rX,a-w "$browsers"
apt-get clean
rm -rf /var/lib/apt/lists/*

# Smoke test as the runtime user: headless launch, prints the Chromium version and checks it against the pin.
home=$(mktemp -d)
chown 10001:10001 "$home"
runuser -u bw -- env HOME="$home" PLAYWRIGHT_BROWSERS_PATH="$browsers" \
  node --input-type=module -e '
const { chromium } = await import(process.argv[1]);
const browser = await chromium.launch({ headless: true });
const version = browser.version();
await browser.close();
console.log(version);
if (version !== process.argv[2]) {
  console.error("install-browser: Chromium " + version + " is not the pinned " + process.argv[2]);
  process.exit(1);
}' "file://$app/node_modules/playwright-core/index.mjs" "$chromium_version" \
  || fail "headless Chromium smoke launch failed"
rm -rf "$home"
echo "install-browser: playwright $pw, @playwright/mcp $pwmcp, chromium $chromium_version (revision $revision) ok"
