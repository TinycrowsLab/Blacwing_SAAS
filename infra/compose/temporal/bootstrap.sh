#!/bin/sh
# Temporal dev bootstrap (DEVENV-007, #161): creates the Blackwing dev namespace and registers the
# custom search attributes the worker epic needs. Idempotent: re-running changes nothing that exists.
#
# Env (all have defaults except the address, which compose provides):
#   TEMPORAL_ADDRESS               gRPC endpoint of the server
#   TEMPORAL_NAMESPACE             namespace to ensure (default blackwing-dev)
#   BW_TEMPORAL_RETENTION          workflow-history retention, e.g. 72h or 7d (default 72h)
#   BW_TEMPORAL_SEARCH_ATTRIBUTES  space-separated Name:Type pairs (default below)
#   BW_TEMPORAL_WAIT_ATTEMPTS      readiness attempts, 2s apart (default 30)
#   TEMPORAL_BIN                   temporal CLI binary (default temporal; tests substitute a stub)
set -eu

BIN="${TEMPORAL_BIN:-temporal}"
NS="${TEMPORAL_NAMESPACE:-blackwing-dev}"
RETENTION="${BW_TEMPORAL_RETENTION:-72h}"
ATTRS="${BW_TEMPORAL_SEARCH_ATTRIBUTES:-runId:Keyword tenantId:Keyword assessmentId:Keyword runState:Keyword}"
ATTEMPTS="${BW_TEMPORAL_WAIT_ATTEMPTS:-30}"
export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-127.0.0.1:7233}"

log() { printf 'temporal-bootstrap: %s\n' "$*"; }

# Server readiness (the compose healthcheck normally guarantees this; retries cover manual use).
i=0
until "$BIN" operator cluster health >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge "$ATTEMPTS" ]; then
    log "server at $TEMPORAL_ADDRESS not healthy after $ATTEMPTS attempts" >&2
    exit 1
  fi
  sleep 2
done

if "$BIN" operator namespace describe --namespace "$NS" >/dev/null 2>&1; then
  log "namespace $NS exists; ensuring retention $RETENTION"
  "$BIN" operator namespace update --namespace "$NS" --retention "$RETENTION" >/dev/null
else
  log "creating namespace $NS (retention $RETENTION)"
  "$BIN" operator namespace create --namespace "$NS" --retention "$RETENTION" \
    --description "Blackwing dev workflows" >/dev/null
fi

# A freshly created namespace takes a moment to propagate through the server's caches, so the first
# search-attribute call can answer "namespace not found": retry until the list works.
i=0
until existing="$("$BIN" operator search-attribute list --namespace "$NS" 2>/dev/null)"; do
  i=$((i + 1))
  if [ "$i" -ge "$ATTEMPTS" ]; then
    log "cannot list search attributes of $NS after $ATTEMPTS attempts" >&2
    exit 1
  fi
  sleep 2
done
for pair in $ATTRS; do
  name="${pair%%:*}"
  type="${pair#*:}"
  if printf '%s\n' "$existing" | grep -Eq "^[[:space:]]*${name}[[:space:]]"; then
    log "search attribute $name already registered"
  else
    log "registering search attribute $name ($type)"
    "$BIN" operator search-attribute create --namespace "$NS" --name "$name" --type "$type" >/dev/null
  fi
done
log "done"
