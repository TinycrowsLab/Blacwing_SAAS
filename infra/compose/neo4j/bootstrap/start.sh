#!/usr/bin/env bash
# DEVENV-002: start Neo4j with the stock entrypoint, then install and VERIFY the tenantId guard
# with cypher-shell. The healthcheck requires /tmp/bw-tenant-guard.ok, so the service is never
# reported healthy without the guard (fails closed).
set -euo pipefail

MARKER=/tmp/bw-tenant-guard.ok
rm -f "$MARKER"

/startup/docker-entrypoint.sh neo4j &
NEO4J_PID=$!
trap 'kill -TERM "$NEO4J_PID" 2>/dev/null; wait "$NEO4J_PID"' TERM INT

cs() { cypher-shell -a bolt://127.0.0.1:7687 -u neo4j -p "$BW_NEO4J_PASSWORD" "$@"; }

for _ in $(seq 1 120); do
  # RETURN only runs in a user database; neo4j is up once its default DB answers.
  if cs -d neo4j 'RETURN 1' >/dev/null 2>&1; then break; fi
  kill -0 "$NEO4J_PID" 2>/dev/null || exit 1
  sleep 2
done

cs -d system -f /bw/bootstrap/tenant-guard.cypher >/dev/null
cs -d neo4j -f /bw/bootstrap/tenant-indexes.cypher >/dev/null

# Verify: a node without tenantId must be rejected (trigger refresh is ~1 s).
for _ in $(seq 1 30); do
  if out=$(cs -d neo4j 'CREATE (n:BwGuardProbe) RETURN n' 2>&1); then
    cs -d neo4j 'MATCH (n:BwGuardProbe) DETACH DELETE n' >/dev/null 2>&1 || true
  elif grep -q BW_TENANT_REQUIRED <<<"$out"; then
    touch "$MARKER"
    echo 'bw: neo4j tenantId guard installed and verified'
    break
  fi
  sleep 1
done
[ -f "$MARKER" ] || echo 'bw: neo4j tenantId guard NOT verified; service stays unhealthy' >&2

wait "$NEO4J_PID"
