#!/usr/bin/env bash
# Offline static checks for every OpenTofu root (INFRA-001): fmt -check, init -backend=false,
# validate, tflint (when installed) and `tofu test` with the mocked AWS provider.
# Never talks to AWS: no backend is initialised and no credentials are needed.
#
# Usage: infra/tofu/scripts/check.sh [root ...]   (default: bootstrap and every environment)
set -euo pipefail

TOFU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOFU="${TOFU:-tofu}"
TFLINT="${TFLINT:-tflint}"

if ! command -v "$TOFU" >/dev/null 2>&1; then
  echo "check.sh: '$TOFU' not found. Install OpenTofu $(cat "$TOFU_DIR/.opentofu-version") (see infra/tofu/README.md)." >&2
  exit 2
fi

want="$(tr -d '[:space:]' <"$TOFU_DIR/.opentofu-version")"
have="$("$TOFU" version -json | sed -n 's/.*"terraform_version": *"\([^"]*\)".*/\1/p')"
if [[ "$have" != "$want" ]]; then
  echo "check.sh: OpenTofu $want is pinned in .opentofu-version but $TOFU is $have." >&2
  exit 2
fi

# required_version in versions.tf must admit exactly the pinned minor series.
pinned_minor="${want%.*}"
if ! grep -qF "required_version = \"~> ${pinned_minor}.0\"" "$TOFU_DIR/versions.tf"; then
  echo "check.sh: versions.tf required_version must be \"~> ${pinned_minor}.0\" to match .opentofu-version ($want)." >&2
  exit 1
fi

# Keep provider downloads and .terraform/ out of the repository.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.cache/blackwing/tofu-plugins}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"
export TF_IN_AUTOMATION=1

if [[ $# -gt 0 ]]; then
  roots=("$@")
else
  roots=(bootstrap environments/dev environments/staging environments/prod)
fi

echo "==> bootstrap stateful resources carry prevent_destroy (idempotent re-run)"
for res in 'aws_kms_key" "state' 'aws_s3_bucket" "state' 'aws_s3_bucket" "logs' 'aws_dynamodb_table" "lock'; do
  block="$(awk -v hdr="resource \"$res\" {" '$0 == hdr {on=1} on {print} on && $0 == "}" {exit}' "$TOFU_DIR/bootstrap/main.tf")"
  if [[ -z "$block" ]] || ! grep -qE '^\s*prevent_destroy\s*=\s*true' <<<"$block"; then
    echo "check.sh: resource \"$res\" in bootstrap/main.tf must set lifecycle.prevent_destroy = true." >&2
    exit 1
  fi
done

echo "==> tofu fmt -check -recursive"
"$TOFU" -chdir="$TOFU_DIR" fmt -check -recursive -diff

for root in "${roots[@]}"; do
  dir="$TOFU_DIR/$root"
  echo "==> $root"
  export TF_DATA_DIR="$WORK/${root//\//_}"
  "$TOFU" -chdir="$dir" init -backend=false -input=false -no-color -lockfile=readonly >"$WORK/init.log" 2>&1 || {
    cat "$WORK/init.log" >&2
    exit 1
  }
  "$TOFU" -chdir="$dir" validate -no-color
  if command -v "$TFLINT" >/dev/null 2>&1; then
    "$TFLINT" --chdir="$dir" --config="$TOFU_DIR/.tflint.hcl" --no-color
  else
    echo "    (tflint not installed; skipped)"
  fi
  "$TOFU" -chdir="$dir" test -no-color
done

echo "==> all OpenTofu roots OK"
