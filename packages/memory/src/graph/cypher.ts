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

/**
 * Node count per kind for a batch of runs (GRAPH-004 read model for the GraphQL surface summary). Provenance is
 * stored flat as `provenance_runId`, so the run is matched on that property; the tenant is pinned on every node.
 */
export function runNodeCountsCypher(): string {
  return [
    'MATCH (n {tenantId: $tenantId})',
    'WHERE n.provenance_runId IN $runIds',
    'RETURN n.provenance_runId AS runId, n.kind AS kind, count(n) AS count',
  ].join('\n');
}

/** Relationship count per kind for a batch of runs. Both the edge and its endpoints are pinned to the tenant. */
export function runEdgeCountsCypher(): string {
  return [
    'MATCH (a {tenantId: $tenantId})-[r]->(b {tenantId: $tenantId})',
    'WHERE r.tenantId = $tenantId AND r.provenance_runId IN $runIds',
    'RETURN r.provenance_runId AS runId, type(r) AS kind, count(r) AS count',
  ].join('\n');
}

/**
 * Technology nodes of a batch of runs with the number of services that run them (`RUNS` edges). A technology
 * with no `RUNS` edge is returned with a count of zero, so the caller can drop it.
 */
export function runTechnologiesCypher(): string {
  return [
    'MATCH (t:Technology {tenantId: $tenantId})',
    'WHERE t.provenance_runId IN $runIds',
    'OPTIONAL MATCH (t)<-[r:RUNS]-()',
    'WHERE r.tenantId = $tenantId',
    'RETURN t.provenance_runId AS runId, t.name AS name, count(r) AS count',
  ].join('\n');
}

/**
 * Endpoint totals of a batch of runs: all endpoints, and those whose asset resolves to at least one in-scope host
 * of the tenant. Endpoints carry no scope flag of their own, so scope is read through the asset (RESOLVES_TO).
 */
export function runEndpointTotalsCypher(): string {
  return [
    'MATCH (e:Endpoint {tenantId: $tenantId})',
    'WHERE e.provenance_runId IN $runIds',
    'OPTIONAL MATCH (a:Asset {tenantId: $tenantId, assetId: e.assetId})-[r:RESOLVES_TO]->(h:Host {tenantId: $tenantId})',
    'WHERE r.tenantId = $tenantId AND h.inScope = true',
    'RETURN e.provenance_runId AS runId,',
    '  count(DISTINCT e) AS endpoints,',
    '  count(DISTINCT CASE WHEN h IS NULL THEN null ELSE e END) AS inScope',
  ].join('\n');
}

/** One keyset page of a run's endpoints, ordered by natural key. */
export function runEndpointsCypher(): string {
  return [
    'MATCH (n:Endpoint)',
    'WHERE n.tenantId = $tenantId',
    '  AND n.provenance_runId = $runId',
    '  AND ($after IS NULL OR n.naturalKey > $after)',
    'RETURN n ORDER BY n.naturalKey LIMIT $limit',
  ].join('\n');
}
