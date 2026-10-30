// Cypher templates of the surface-graph repository (GRAPH-004, §8.6). Every template binds `$tenantId`: the
// repository merges the ambient tenant into the parameters, and `cypher.test.ts` fails if a template does not
// reference it. Labels and relationship types cannot be bound as parameters, so they are interpolated from the
// closed contract enums only (`SURFACE_NODE_KINDS`, `SURFACE_EDGE_KINDS`), never from caller input.

import type { SurfaceEdgeKind, SurfaceNodeKind } from '@blackwing/contracts';

/**
 * A stub is a placeholder node that an edge needed before its endpoint was observed (GRAPH-007). Stubs are real
 * nodes, but they carry no contract fields, so every node read and count excludes them until an observation
 * upgrades them (the upsert clears the flag).
 */
function LIVE(variable: string): string {
  return `coalesce(${variable}.stub, false) = false`;
}

/** The Neo4j label of each node kind. */
const NODE_LABELS: Readonly<Record<SurfaceNodeKind, string>> = Object.freeze({
  asset: 'Asset',
  host: 'Host',
  service: 'Service',
  technology: 'Technology',
  endpoint: 'Endpoint',
  parameter: 'Parameter',
  role: 'Role',
  spec_document: 'SpecDocument',
  schema_object: 'SchemaObject',
  auth_scheme: 'AuthScheme',
  source_route: 'SourceRoute',
  config_item: 'ConfigItem',
});

/** MERGE a node on its tenant and natural key, then refresh its properties. */
export function mergeNodeCypher(kind: SurfaceNodeKind): string {
  return `MERGE (n:${NODE_LABELS[kind]} {tenantId: $tenantId, naturalKey: $naturalKey}) SET n += $props`;
}

/** Fetch one node of a kind by natural key. */
export function getNodeCypher(kind: SurfaceNodeKind): string {
  return [
    `MATCH (n:${NODE_LABELS[kind]} {tenantId: $tenantId, naturalKey: $naturalKey})`,
    `WHERE ${LIVE('n')}`,
    'RETURN n LIMIT 1',
  ].join('\n');
}

/** One page of nodes of a kind, filtered on top-level properties, keyset-paginated on the natural key. */
export function listNodesCypher(kind: SurfaceNodeKind): string {
  return [
    `MATCH (n:${NODE_LABELS[kind]})`,
    'WHERE n.tenantId = $tenantId',
    '  AND ($after IS NULL OR n.naturalKey > $after)',
    `  AND ${LIVE('n')}`,
    '  AND all(key IN $filterKeys WHERE n[key] = $filter[key])',
    'RETURN n ORDER BY n.naturalKey LIMIT $limit',
  ].join('\n');
}

/** Count of nodes of a kind in the ambient tenant. */
export function countNodesCypher(kind: SurfaceNodeKind): string {
  return `MATCH (n:${NODE_LABELS[kind]} {tenantId: $tenantId}) WHERE ${LIVE('n')} RETURN count(n) AS count`;
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
    `  AND ${LIVE('n')}`,
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
    `  AND ${LIVE('n')}`,
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
    `  AND ${LIVE('t')}`,
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
    `  AND ${LIVE('e')}`,
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
    `  AND ${LIVE('n')}`,
    '  AND ($after IS NULL OR n.naturalKey > $after)',
    'RETURN n ORDER BY n.naturalKey LIMIT $limit',
  ].join('\n');
}

/**
 * The candidate predicate of the run surface for one node or edge variable: in the ambient tenant, first seen or
 * last refreshed by the run (`provenance_runId`), of the wanted kinds (all kinds when `$kinds` is null), at least
 * `$minConfidence`, and not marked out of scope when `$inScopeOnly` is set. Every term is parameterised; only the
 * variable name is interpolated, and it is one of this file's.
 */
function candidate(variable: string): string {
  return [
    `${variable}.tenantId = $tenantId`,
    `${variable}.provenance_runId = $runId`,
    `($kinds IS NULL OR ${variable}.kind IN $kinds)`,
    `${variable}.provenance_confidence >= $minConfidence`,
    LIVE(variable),
    `(NOT $inScopeOnly OR ${variable}.inScope IS NULL OR ${variable}.inScope = true)`,
  ].join(' AND ');
}

/** Full number of candidate nodes of a run surface (before the node cap). */
export function runSurfaceNodeCountCypher(): string {
  return `MATCH (n) WHERE ${candidate('n')} RETURN count(n) AS count`;
}

/** Full number of relationships whose two ends are candidate nodes (before the edge cap). */
export function runSurfaceEdgeCountCypher(): string {
  return `MATCH (a)-[r]->(b) WHERE ${candidate('a')} AND ${candidate('b')} RETURN count(r) AS count`;
}

/**
 * The retained node set of a run surface, ranked by degree (edges to other candidates), then confidence, then natural
 * key, and cut to `$nodeCap`. The keyset cursor (`$after`) pages inside that set, ordered by natural key, so the set
 * and its order are the same on every page of one request. Degree is computed here, server-side, never in the app.
 */
export function runSurfaceRankedCypher(): string {
  return [
    `MATCH (n) WHERE ${candidate('n')}`,
    `OPTIONAL MATCH (n)-[r]-(m) WHERE ${candidate('m')}`,
    'WITH n, count(r) AS degree',
    'ORDER BY degree DESC, n.provenance_confidence DESC, n.naturalKey ASC',
    'LIMIT $nodeCap',
    'WITH n, degree WHERE $after IS NULL OR n.naturalKey > $after',
    'RETURN n, degree ORDER BY n.naturalKey LIMIT $limit',
  ].join('\n');
}

/**
 * Relationships between the given page nodes (`$keys`), in both ends' run and tenant. One row past `$limit` tells the
 * caller the edge set was cut. A relationship is returned only when both of its ends are in the page, so the view
 * never holds a dangling reference.
 */
export function runSurfaceEdgesCypher(): string {
  return [
    'MATCH (a)-[r]->(b)',
    'WHERE a.tenantId = $tenantId AND b.tenantId = $tenantId',
    '  AND a.provenance_runId = $runId AND b.provenance_runId = $runId',
    '  AND a.naturalKey IN $keys AND b.naturalKey IN $keys',
    'RETURN type(r) AS kind, a.naturalKey AS fromKey, b.naturalKey AS toKey',
    'ORDER BY fromKey, kind, toKey LIMIT $limit',
  ].join('\n');
}

/**
 * The provenance merge of an existing node or relationship `v` (GRAPH-007, §8.11). It is commutative, so concurrent
 * writers converge: confidence keeps the larger value; lastSeenAt keeps the lexically larger ISO-UTC value; the run
 * that last saw it is the one with the larger lastSeenAt, ties broken by the larger run id. `firstSeenAt` is never
 * touched. The values before the merge are captured in a WITH first, so the result does not depend on the order of
 * the SET items. Ends with `created` in scope, read from the ON CREATE marker, and clears that marker.
 */
function mergeProvenance(v: string): string[] {
  return [
    `WITH ${v}, row, coalesce(${v}.upsertCreated, false) AS created,`,
    `  ${v}.provenance_confidence AS oldConfidence,`,
    `  ${v}.provenance_lastSeenAt AS oldLastSeenAt,`,
    `  ${v}.provenance_runId AS oldRunId`,
    `SET ${v}.upsertCreated = null,`,
    `  ${v}.provenance_confidence = CASE WHEN row.confidence > oldConfidence THEN row.confidence ELSE oldConfidence END,`,
    `  ${v}.provenance_lastSeenAt = CASE WHEN row.lastSeenAt > oldLastSeenAt THEN row.lastSeenAt ELSE oldLastSeenAt END,`,
    `  ${v}.provenance_runId = CASE`,
    '    WHEN row.lastSeenAt > oldLastSeenAt OR (row.lastSeenAt = oldLastSeenAt AND row.runId > oldRunId)',
    `    THEN row.runId ELSE oldRunId END`,
    `WITH ${v}, row, created`,
  ];
}

/**
 * Idempotent batch upsert of one kind of node (GRAPH-007). `$rows` carries `naturalKey`, `props` (new node),
 * `facts` (refreshed on match), `confidence`, `lastSeenAt`, `runId`, `observationKey` and `observation`. A node that
 * already exists keeps its firstSeenAt, merges provenance (see {@link mergeProvenance}), links to its run with
 * `OBSERVED_IN`, and gets one `Observation` per `(run, natural key, tool)`. Returns one `created` flag per row.
 */
export function upsertNodesCypher(kind: SurfaceNodeKind): string {
  return [
    'UNWIND $rows AS row',
    `MERGE (n:${NODE_LABELS[kind]} {tenantId: $tenantId, naturalKey: row.naturalKey})`,
    '  ON CREATE SET n += row.props, n.upsertCreated = true',
    '  ON MATCH SET n += row.facts, n.stub = null',
    ...mergeProvenance('n'),
    'MERGE (run:Run {tenantId: $tenantId, runId: row.runId})',
    'MERGE (n)-[:OBSERVED_IN]->(run)',
    'MERGE (o:Observation {tenantId: $tenantId, observationKey: row.observationKey})',
    '  ON CREATE SET o += row.observation',
    'MERGE (n)-[:HAS_OBSERVATION]->(o)',
    'MERGE (o)-[:IN_RUN]->(run)',
    'RETURN created',
  ].join('\n');
}

/**
 * Creates the placeholder nodes an edge needs when they are absent (GRAPH-007). An existing node is left alone; a new
 * one gets `stub: true`, the endpoint's kind and a confidence of 0. Returns how many were created.
 */
export function upsertStubsCypher(kind: SurfaceNodeKind): string {
  return [
    'UNWIND $rows AS row',
    `MERGE (n:${NODE_LABELS[kind]} {tenantId: $tenantId, naturalKey: row.naturalKey})`,
    '  ON CREATE SET n.stub = true, n.kind = row.kind, n.upsertCreated = true,',
    '    n.provenance_runId = row.runId, n.provenance_confidence = 0.0,',
    '    n.provenance_firstSeenAt = row.firstSeenAt, n.provenance_lastSeenAt = row.lastSeenAt',
    'WITH n, coalesce(n.upsertCreated, false) AS created',
    'SET n.upsertCreated = null',
    'RETURN sum(CASE WHEN created THEN 1 ELSE 0 END) AS stubs',
  ].join('\n');
}

/**
 * Idempotent batch upsert of one kind of relationship (GRAPH-007). Both endpoints are matched by natural key in the
 * tenant (the stubs are created first, see {@link upsertStubsCypher}). The relationship keeps its provenance under the
 * same merge rules as nodes. Returns one row per relationship with its `created` flag; a row is missing only when an
 * endpoint is absent.
 */
export function upsertEdgesCypher(kind: SurfaceEdgeKind): string {
  return [
    'UNWIND $rows AS row',
    'MATCH (a {tenantId: $tenantId, naturalKey: row.fromKey})',
    'MATCH (b {tenantId: $tenantId, naturalKey: row.toKey})',
    `MERGE (a)-[r:${kind} {tenantId: $tenantId, fromKey: row.fromKey, toKey: row.toKey}]->(b)`,
    '  ON CREATE SET r += row.props, r.upsertCreated = true',
    '  ON MATCH SET r += row.facts',
    ...mergeProvenance('r'),
    'RETURN created',
  ].join('\n');
}
