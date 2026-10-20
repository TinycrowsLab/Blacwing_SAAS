#!/bin/sh
# Compose healthcheck for OpenBao (DEVENV-005). Probes /v1/sys/health.
#   dev mode:  healthy only when initialised, unsealed and active (HTTP 200).
#   file mode: healthy once the API answers, even sealed or uninitialised, so `bootstrap.sh` can
#              initialise/unseal it; bootstrap itself then requires the strict 200.
set -eu
if [ "${BW_OPENBAO_STORAGE:-dev}" = file ]; then
  query='?uninitcode=200&sealedcode=200&standbycode=200'
else
  query=''
fi
wget -q -O /dev/null "http://127.0.0.1:8200/v1/sys/health${query}"
