// Cypher templates of the surface-graph repository (GRAPH-004, §8.6). Every template binds `$tenantId`: the
// repository merges the ambient tenant into the parameters, and `cypher.test.ts` fails if a template does not
// reference it. Labels and relationship types cannot be bound as parameters, so they are interpolated from the
// closed contract enums only (`SURFACE_NODE_KINDS`, `SURFACE_EDGE_KINDS`), never from caller input.

import type { SurfaceEdgeKind, SurfaceNodeKind } from '@blackwing/contracts';

/** The Neo4j label of each node kind. */
const NODE_LABELS: Readonly<Record<SurfaceNodeKind, string>> = Object.freeze({
  asset: 'Asset',
  host: 'Host',
  service: 'Service',
  technology: 'Technology',
  endpoint: 'Endpoint',
  parameter: 'Parameter',
  role: 'Role',
});

/** MERGE a node on its tenant and natural key, then refresh its properties. */
export function mergeNodeCypher(kind: SurfaceNodeKind): string {
  return `MERGE (n:${NODE_LABELS[kind]} {tenantId: $tenantId, naturalKey: $naturalKey}) SET n += $props`;
}

/** Fetch one node of a kind by natural key. */
export function getNodeCypher(kind: SurfaceNodeKind): string {
  return `MATCH (n:${NODE_LABELS[kind]} {tenantId: $tenantId, naturalKey: $naturalKey}) RETURN n LIMIT 1`;
}

/** One page of nodes of a kind, filtered on top-level properties, keyset-paginated on the natural key. */
export function listNodesCypher(kind: SurfaceNodeKind): string {
  return [
    `MATCH (n:${NODE_LABELS[kind]})`,
    'WHERE n.tenantId = $tenantId',
    '  AND ($after IS NULL OR n.naturalKey > $after)',
    '  AND all(key IN $filterKeys WHERE n[key] = $filter[key])',
    'RETURN n ORDER BY n.naturalKey LIMIT $limit',
  ].join('\n');
}

/** Count of nodes of a kind in the ambient tenant. */
export function countNodesCypher(kind: SurfaceNodeKind): string {
  return `MATCH (n:${NODE_LABELS[kind]} {tenantId: $tenantId}) RETURN count(n) AS count`;
}

/** MERGE a relationship between two nodes of the same tenant. Returns 0 rows when an endpoint is absent. */
export function mergeEdgeCypher(kind: SurfaceEdgeKind): string {
  return [
    'MATCH (a {tenantId: $tenantId, naturalKey: $fromKey})',
    'MATCH (b {tenantId: $tenantId, naturalKey: $toKey})',
    `MERGE (a)-[r:${kind} {tenantId: $tenantId, fromKey: $fromKey, toKey: $toKey}]->(b)`,
    'SET r += $props',
    'RETURN count(r) AS written',
  ].join('\n');
}

/**
 * Nodes reachable from `start` over the listed edge kinds within `depth` hops. Neo4j does not accept a parameter as a
 * variable-length bound, so the depth is interpolated; it is the literal 1 or 2 that the repository validates. Both
 * ends and every hop are pinned to the ambient tenant. One extra row beyond `$limit` tells the caller the result was
 * truncated.
 */
export function neighboursCypher(depth: 1 | 2): string {
  return [
    'MATCH (start {tenantId: $tenantId, naturalKey: $naturalKey})',
    `  -[rels*1..${depth}]-`,
    '  (n {tenantId: $tenantId})',
    'WHERE n <> start',
    '  AND all(r IN rels WHERE type(r) IN $edgeKinds AND r.tenantId = $tenantId)',
    'RETURN DISTINCT n ORDER BY n.naturalKey LIMIT $limit',
  ].join('\n');
}
