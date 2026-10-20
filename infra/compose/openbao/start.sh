#!/bin/sh
# OpenBao dev server entrypoint (DEVENV-005, #159). Runs under the image's dumb-init.
#
#   BW_OPENBAO_STORAGE=dev  (default) `bao server -dev`: in-memory, ephemeral, already unsealed, root
#                           token = BAO_DEV_ROOT_TOKEN_ID (from the untracked .env).
#   BW_OPENBAO_STORAGE=file persistent file backend on the `openbaodata` volume; bootstrap.sh
#                           initialises and unseals it.
#
# Both modes load the declarative audit device (config/audit.hcl).
set -eu

mode="${BW_OPENBAO_STORAGE:-dev}"
cfg=/openbao/config
cp /bw/openbao/config/audit.hcl "$cfg/audit.hcl"

case "$mode" in
  dev)
    if [ -z "${BAO_DEV_ROOT_TOKEN_ID:-}" ]; then
      echo "openbao: BAO_DEV_ROOT_TOKEN_ID is empty; refusing to start with a random root token" >&2
      exit 1
    fi
    rm -f "$cfg/storage-file.hcl"
    exec docker-entrypoint.sh server -dev
    ;;
  file)
    cp /bw/openbao/config/storage-file.hcl "$cfg/storage-file.hcl"
    unset BAO_DEV_ROOT_TOKEN_ID
    exec su-exec openbao bao server -config="$cfg"
    ;;
  *)
    echo "openbao: unknown BW_OPENBAO_STORAGE '$mode' (expected dev | file)" >&2
    exit 1
    ;;
esac
