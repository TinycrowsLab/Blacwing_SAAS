#!/usr/bin/env bash
# INFRA-010: installs and VERIFIES the tenantId guard (DEVENV-002 logic, same cypher as compose) against the
# in-cluster Neo4j. Runs as the post-install/post-upgrade `neo4j-guard` Job. The Job fails unless the guard
# rejects a node without tenantId, so a release never reports success with the guard missing (fails closed).
set -euo pipefail

: "${NEO4J_AUTH:?}" "${NEO4J_BOLT_URI:?}"
PASSWORD="${NEO4J_AUTH#neo4j/}"
cs() { cypher-shell -a "$NEO4J_BOLT_URI" -u neo4j -p "$PASSWORD" "$@"; }

for _ in $(seq 1 60); do
  if cs -d neo4j 'RETURN 1' >/dev/null 2>&1; then break; fi
  sleep 5
done
cs -d neo4j 'RETURN 1' >/dev/null

cs -d system -f /bw/neo4j/tenant-guard.cypher >/dev/null
cs -d neo4j -f /bw/neo4j/tenant-indexes.cypher >/dev/null

# Verify: a node without tenantId must be rejected (trigger refresh is about 1 s).
for _ in $(seq 1 30); do
  if out=$(cs -d neo4j 'CREATE (n:BwGuardProbe) RETURN n' 2>&1); then
    cs -d neo4j 'MATCH (n:BwGuardProbe) DETACH DELETE n' >/dev/null 2>&1 || true
  elif grep -q BW_TENANT_REQUIRED <<<"$out"; then
    echo 'neo4j-guard: tenantId guard installed and verified'
    exit 0
  fi
  sleep 1
done

echo 'neo4j-guard: tenantId guard NOT verified; failing the release' >&2
exit 1
