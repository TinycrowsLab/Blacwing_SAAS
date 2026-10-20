#!/bin/sh
# bw-sandbox entrypoint: enforce the runtime contract, then exec the command as PID 1's child.
set -eu
if [ "$(id -u)" = "0" ]; then
  echo "bw-sandbox: refusing to run as root (expected uid 10001)" >&2
  exit 77
fi
probe="/workspace/.bw-write-probe.$$"
if ! (: > "$probe") 2>/dev/null; then
  echo "bw-sandbox: /workspace is not writable; mount a tmpfs there (uid=10001) per the sandbox contract" >&2
  exit 78
fi
rm -f "$probe"
exec "$@"
