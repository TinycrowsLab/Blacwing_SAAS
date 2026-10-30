// The tenant-guarded surface-graph repository (GRAPH-004, CONTEXT_PACK §3.1, §8.6). It is the only sanctioned way
// to read or write the Neo4j surface graph. Neo4j has no row-level security, so this module is the enforcement
// point: it takes `tenantId` from the ambient tenant context (`@blackwing/db/tenant-context`), binds it into every
// query, and fails closed before any query is sent when there is no context or the tenant does not match.
//
// Results are parsed with the GRAPH-003 contracts on the way out, so a malformed stored node is an error and never
// reaches a caller as an untyped object.

import { SpanStatusCode, trace } from '@opentelemetry/api';
import neo4j, { type Record as GraphRecord, type Session } from 'neo4j-driver';
import { z } from 'zod';

import {
  type AuditActor,
  type EndpointNode,
  endpointNodeSchema,
  SURFACE_EDGE_KINDS,
  SURFACE_NODE_KINDS,
  type SurfaceEdge,
  surfaceEdgeKindSchema,
  type SurfaceEdgeKind,
  surfaceEdgeSchema,
  type SurfaceNode,
  surfaceNodeKindSchema,
  type SurfaceNodeKind,
  surfaceNodeSchema,
  naturalKey,
} from '@blackwing/contracts';
import {
  getTenantContext,
  hashTenantId,
  runWithTenantContext,
  type TenantActor,
  type TenantContext,
} from '@blackwing/db/tenant-context';
import { AppError } from '@blackwing/errors';

import {
  countNodesCypher,
  getNodeCypher,
  upsertEdgesCypher,
  upsertNodesCypher,
  upsertStubsCypher,
  listNodesCypher,
  mergeEdgeCypher,
  mergeNodeCypher,
  neighboursCypher,
  runEdgeCountsCypher,
  runEndpointsCypher,
  runEndpointTotalsCypher,
  runNodeCountsCypher,
  runTechnologiesCypher,
  runSurfaceEdgeCountCypher,
  runSurfaceEdgesCypher,
  runSurfaceNodeCountCypher,
  runSurfaceRankedCypher,
} from './cypher.js';
import { getGraph, type GraphRuntime, withSessionOn } from './driver.js';

import type { AuditEmitter, AuditEventInput } from '@blackwing/audit';

/** Hard cap on the nodes one `getNeighbours` call returns; a larger result is reported as truncated. */
export const NEIGHBOUR_LIMIT = 100;
/** Largest page `listNodes` returns. */
export const LIST_PAGE_MAX = 200;
/** Most technologies a run summary lists (the most widely run first). */
export const TOP_TECHNOLOGIES_MAX = 10;
/** Largest number of runs one `summariseRuns` call takes (one batch of DataLoader keys). */
export const SUMMARY_RUNS_MAX = 100;
const KEY_MAX = 4096;
const FILTER_KEY = /^[a-z][A-Za-z0-9]*$/;
const SERVICE_ACTOR: TenantActor = Object.freeze({ type: 'service', id: 'surface-graph' });
const PROVENANCE_PREFIX = 'provenance_';
const UPSERT_ACTION = 'graph.surface.upserted';

const tracer = trace.getTracer('@blackwing/memory');

/** Repository operations, as named in the `graph.repo.<op>` span and the `op` metric label. */
export type SurfaceGraphOp =
  | 'writeNode'
  | 'writeEdge'
  | 'getNode'
  | 'listNodes'
  | 'getNeighbours'
  | 'countByTenant'
  | 'summariseRuns'
  | 'listRunEndpoints'
  | 'readRunSurface'
  | 'upsertNodes'
  | 'upsertEdges';

/** Counters (OBS wires these to Prometheus; the default is a no-op). */
export interface SurfaceGraphMetrics {
  /** `graph_query_total{op,mode}`. */
  queryTotal(op: SurfaceGraphOp, mode: 'READ' | 'WRITE'): void;
  /** `graph_query_errors_total{code}`. */
  queryError(code: string): void;
  /** `graph_upsert_nodes_total{kind,op}` and `graph_upsert_edges_total{kind,op}`: rows written per kind and outcome. */
  upsertCounted?(
    entity: 'node' | 'edge',
    kind: string,
    op: 'created' | 'updated',
    count: number,
  ): void;
  /** `graph_upsert_batch_ms`: duration of one upsert call. */
  upsertBatchMs?(entity: 'node' | 'edge', ms: number): void;
}

const NOOP_METRICS: SurfaceGraphMetrics = {
  queryTotal: () => undefined,
  queryError: () => undefined,
};

/**
 * The audit port of surface growth (GRAPH-007, §8.8). The composition root binds it to `AuditEmitter`; an upsert
 * refuses to write without it.
 */
export type SurfaceUpsertAudit = Pick<AuditEmitter, 'emitAudit'>;

/** Options for {@link SurfaceGraphRepository}. */
export interface SurfaceGraphOptions {
  readonly metrics?: SurfaceGraphMetrics;
  readonly audit?: SurfaceUpsertAudit;
}

/** Rows an upsert created, and rows that already existed and were refreshed. */
export interface UpsertCounts {
  readonly created: number;
  readonly updated: number;
}

/** The result of {@link SurfaceGraphRepository.upsertNodes}: totals and the counts per kind (all kinds, zero when absent). */
export interface UpsertResult<K extends string = SurfaceNodeKind> extends UpsertCounts {
  readonly byKind: Record<K, UpsertCounts>;
}

/** The result of {@link SurfaceGraphRepository.upsertEdges}: the relationship counts, and the placeholder nodes created. */
export interface EdgeUpsertResult extends UpsertResult<SurfaceEdgeKind> {
  /** Placeholder endpoint nodes (`stub: true`) created because they were absent. */
  readonly stubs: number;
}

/** A page of nodes. `nextCursor` is set when more nodes follow; pass it back as `after`. */
export interface NodePage {
  readonly nodes: SurfaceNode[];
  readonly nextCursor?: string;
}

/** A neighbourhood. `truncated` is set when more than {@link NEIGHBOUR_LIMIT} nodes matched. */
export interface Neighbourhood {
  readonly nodes: SurfaceNode[];
  readonly truncated: boolean;
}

/** A count of one kind (node kind or relationship type) in a run. */
export interface KindCount<K extends string> {
  readonly kind: K;
  readonly count: number;
}

/** A technology of a run and how many services run it. */
export interface TechnologyCount {
  readonly name: string;
  readonly count: number;
}

/**
 * The surface of one run, read from the graph (GRAPH-004 read model). Kinds with no nodes or edges are omitted, so
 * an empty run has empty counts and zero endpoints.
 */
export interface RunSurfaceSummary {
  readonly runId: string;
  readonly nodeCounts: readonly KindCount<SurfaceNodeKind>[];
  readonly edgeCounts: readonly KindCount<SurfaceEdgeKind>[];
  readonly topTechnologies: readonly TechnologyCount[];
  readonly endpointCount: number;
  readonly inScopeEndpointCount: number;
}

/** A keyset page of a run's endpoints. `nextCursor` is set when more follow; pass it back as `after`. */
export interface EndpointPage {
  readonly nodes: EndpointNode[];
  readonly nextCursor?: string;
}

/** Parameters of one run-surface read (GRAPH-006): the filters, the page and the two caps. */
export interface RunSurfaceQuery {
  /** Node kinds to keep; absent keeps every kind. */
  readonly kinds?: readonly SurfaceNodeKind[];
  /** Keep nodes and edges whose provenance confidence is at least this (0 to 1). */
  readonly minConfidence: number;
  /** Drop hosts marked out of scope (`inScope = false`); nodes of other kinds carry no scope flag and stay. */
  readonly inScopeOnly?: boolean;
  /** Natural key of the last node of the previous page; the page continues after it. */
  readonly after?: string;
  /** Page size, 1 to {@link LIST_PAGE_MAX}. */
  readonly limit: number;
  /** Most nodes selected for the whole surface; the highest-degree nodes are kept. */
  readonly nodeCap: number;
  /** Most relationships returned in one page. */
  readonly edgeCap: number;
}

/** A node of a run surface, with its degree among the candidate nodes. */
export interface RunSurfaceNode {
  readonly node: SurfaceNode;
  readonly degree: number;
}

/** A relationship between two nodes of one page, named by their natural keys. */
export interface RunSurfaceEdge {
  readonly kind: SurfaceEdgeKind;
  readonly fromKey: string;
  readonly toKey: string;
}

/**
 * One page of a run surface. `totals` are the full candidate counts, before any cap. `nextCursor` is set when more
 * nodes follow. `edgesTruncated` is set when the page held more relationships than the edge cap.
 */
export interface RunSurface {
  readonly totals: { readonly nodes: number; readonly edges: number };
  readonly nodes: readonly RunSurfaceNode[];
  readonly nextCursor?: string;
  readonly edges: readonly RunSurfaceEdge[];
  readonly edgesTruncated: boolean;
}

const keySchema = z.string().min(1).max(KEY_MAX);
const runIdSchema = z.uuid();
const runIdsSchema = z.array(runIdSchema).max(SUMMARY_RUNS_MAX);
const runSurfaceQuerySchema = z.object({
  kinds: z.array(surfaceNodeKindSchema).min(1).optional(),
  minConfidence: z.number().min(0).max(1),
  inScopeOnly: z.boolean().optional(),
  after: keySchema.optional(),
  limit: z.int().min(1).max(LIST_PAGE_MAX),
  nodeCap: z.int().min(1),
  edgeCap: z.int().min(1),
});

const pageSchema = z.object({
  limit: z.int().min(1).max(LIST_PAGE_MAX),
  after: keySchema.optional(),
});
const filterSchema = z.record(
  z.string().regex(FILTER_KEY, 'filter keys must be plain property names'),
  z.union([z.string(), z.number(), z.boolean()]),
);
const depthSchema = z.union([z.literal(1), z.literal(2)]);
const edgeKindsSchema = z.array(surfaceEdgeKindSchema).min(1);

/**
 * Flattens a node or edge into Neo4j properties: provenance becomes `provenance_<field>` because Neo4j stores
 * no nested maps; `undefined` optional fields are dropped. The natural key is stored for every node and edge so
 * a single index-friendly match addresses it.
 */
function storedProps(value: SurfaceNode | SurfaceEdge): Record<string, unknown> {
  return { ...storedFacts(value), ...storedProvenance(value) };
}

/** The fact fields of a node or edge, flattened (no provenance). */
function storedFacts(value: SurfaceNode | SurfaceEdge): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== 'provenance' && field !== undefined) props[key] = field;
  }
  return props;
}

/** The provenance of a node or edge, flattened as `provenance_<field>`. */
function storedProvenance(value: SurfaceNode | SurfaceEdge): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value.provenance)) {
    if (field !== undefined) props[`${PROVENANCE_PREFIX}${key}`] = field;
  }
  return props;
}

/** Drops `undefined` values: Neo4j parameters and properties take no undefined. */
function definedOnly(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, field]) => field !== undefined));
}

/** Reads a stored string (a run id or a technology name); anything else is a stored-data fault. */
function storedString(value: unknown): string {
  const raw = plain(value);
  if (typeof raw !== 'string') {
    throw new AppError('GRAPH_QUERY_FAILED', 'stored surface value is not a string');
  }
  return raw;
}

/** Reads a stored enum value; a value outside the contract is a stored-data fault, never a silent pass. */
function storedEnum<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(plain(value));
  if (!parsed.success) {
    throw new AppError('GRAPH_QUERY_FAILED', 'stored surface kind failed contract validation', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Parses a caller's input with its contract schema; a bad value is a validation error, never a silent coercion. */
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'invalid surface graph input', { cause: parsed.error });
  }
  return parsed.data;
}

/** Neo4j returns 64-bit integers as objects; the contracts expect plain numbers. */
function plain(value: unknown): unknown {
  if (neo4j.isInt(value)) return value.toNumber();
  return value;
}

/** Rebuilds a contract value from stored properties and parses it. A stored value that fails parsing is a fault. */
function parseStored<T>(props: Record<string, unknown>, schema: z.ZodType<T>): T {
  const value: Record<string, unknown> = {};
  const provenance: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(props)) {
    if (key === 'naturalKey') continue;
    if (key.startsWith(PROVENANCE_PREFIX)) {
      provenance[key.slice(PROVENANCE_PREFIX.length)] = plain(field);
    } else {
      value[key] = plain(field);
    }
  }
  value.provenance = provenance;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('GRAPH_QUERY_FAILED', 'stored surface value failed contract validation', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function nodeProps(record: GraphRecord, field = 'n'): Record<string, unknown> {
  const node = record.get(field) as { properties: Record<string, unknown> };
  return node.properties;
}

/** The tenant-scoped surface-graph repository. Construct it inside {@link withTenantGraph}. */
export class SurfaceGraphRepository {
  readonly #runtime: GraphRuntime;
  readonly #metrics: SurfaceGraphMetrics;
  readonly #audit: SurfaceUpsertAudit | undefined;

  constructor(runtime: GraphRuntime, options: SurfaceGraphOptions = {}) {
    this.#runtime = runtime;
    this.#metrics = options.metrics ?? NOOP_METRICS;
    this.#audit = options.audit;
  }

  /** Upserts a node in the ambient tenant. `node.tenantId` must equal the context tenant. */
  async writeNode(node: SurfaceNode): Promise<void> {
    const parsed = input(surfaceNodeSchema, node);
    this.#scope('writeNode', parsed.tenantId);
    await this.#execute('writeNode', 'WRITE', mergeNodeCypher(parsed.kind), {
      naturalKey: naturalKey(parsed),
      props: storedProps(parsed),
    });
  }

  /**
   * Upserts a relationship between two nodes of the ambient tenant. Resolves to `false` when either endpoint is
   * not stored in this tenant, so an edge can never attach to another tenant's node.
   */
  async writeEdge(edge: SurfaceEdge): Promise<boolean> {
    const parsed = input(surfaceEdgeSchema, edge);
    this.#scope('writeEdge', parsed.tenantId);
    const rows = await this.#execute('writeEdge', 'WRITE', mergeEdgeCypher(parsed.kind), {
      fromKey: parsed.fromKey,
      toKey: parsed.toKey,
      props: storedProps(parsed),
    });
    return rows.some((row) => plain(row.get('written')) !== 0);
  }

  /** The node of `kind` with this natural key in the ambient tenant, or `undefined`. */
  async getNode(kind: SurfaceNodeKind, key: string): Promise<SurfaceNode | undefined> {
    const parsedKind = input(surfaceNodeKindSchema, kind);
    const naturalKeyValue = input(keySchema, key);
    const rows = await this.#execute('getNode', 'READ', getNodeCypher(parsedKind), {
      naturalKey: naturalKeyValue,
    });
    const [row] = rows;
    return row === undefined ? undefined : parseStored(nodeProps(row), surfaceNodeSchema);
  }

  /**
   * One page of nodes of `kind` in the ambient tenant. `filter` matches top-level properties exactly. Pages are
   * ordered by natural key; pass `nextCursor` back as `after` to continue.
   */
  async listNodes(
    kind: SurfaceNodeKind,
    filter: Readonly<Record<string, string | number | boolean>>,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<NodePage> {
    const parsedKind = input(surfaceNodeKindSchema, kind);
    const parsedFilter = input(filterSchema, filter);
    const parsedPage = input(pageSchema, page);
    const rows = await this.#execute('listNodes', 'READ', listNodesCypher(parsedKind), {
      after: parsedPage.after ?? null,
      filterKeys: Object.keys(parsedFilter),
      filter: parsedFilter,
      limit: neo4j.int(parsedPage.limit + 1),
    });
    const nodes = rows
      .slice(0, parsedPage.limit)
      .map((row) => parseStored(nodeProps(row), surfaceNodeSchema));
    const last = nodes.at(-1);
    const more = rows.length > parsedPage.limit && last !== undefined;
    return more ? { nodes, nextCursor: naturalKey(last) } : { nodes };
  }

  /**
   * Nodes within `depthLimit` (1 or 2) hops of the node `key` over the listed edge kinds, capped at
   * {@link NEIGHBOUR_LIMIT}.
   */
  async getNeighbours(
    key: string,
    edgeKinds: readonly SurfaceEdgeKind[],
    depthLimit: 1 | 2,
  ): Promise<Neighbourhood> {
    const naturalKeyValue = input(keySchema, key);
    const kinds = input(edgeKindsSchema, edgeKinds);
    const depth = input(depthSchema, depthLimit);
    const rows = await this.#execute('getNeighbours', 'READ', neighboursCypher(depth), {
      naturalKey: naturalKeyValue,
      edgeKinds: kinds,
      limit: neo4j.int(NEIGHBOUR_LIMIT + 1),
    });
    const nodes = rows
      .slice(0, NEIGHBOUR_LIMIT)
      .map((row) => parseStored(nodeProps(row), surfaceNodeSchema));
    return { nodes, truncated: rows.length > NEIGHBOUR_LIMIT };
  }

  /**
   * Surface summaries of several runs of the ambient tenant, in four tenant-pinned reads (nodes, edges, technologies,
   * endpoints) whatever the number of runs. A run without any graph data is returned as an empty summary; the caller
   * decides whether the run itself exists.
   */
  async summariseRuns(runIds: readonly string[]): Promise<Map<string, RunSurfaceSummary>> {
    const parsedRunIds = input(runIdsSchema, runIds);
    const summaries = new Map<string, MutableSummary>(
      parsedRunIds.map((runId) => [runId, emptyMutableSummary()]),
    );
    if (parsedRunIds.length === 0) return new Map();
    const params = { runIds: [...parsedRunIds] };

    for (const row of await this.#execute('summariseRuns', 'READ', runNodeCountsCypher(), params)) {
      const summary = summaries.get(storedString(row.get('runId')));
      if (summary === undefined) continue;
      summary.nodeCounts.push({
        kind: storedEnum(surfaceNodeKindSchema, row.get('kind')),
        count: Number(plain(row.get('count'))),
      });
    }
    for (const row of await this.#execute('summariseRuns', 'READ', runEdgeCountsCypher(), params)) {
      const summary = summaries.get(storedString(row.get('runId')));
      if (summary === undefined) continue;
      summary.edgeCounts.push({
        kind: storedEnum(surfaceEdgeKindSchema, row.get('kind')),
        count: Number(plain(row.get('count'))),
      });
    }
    for (const row of await this.#execute(
      'summariseRuns',
      'READ',
      runTechnologiesCypher(),
      params,
    )) {
      const summary = summaries.get(storedString(row.get('runId')));
      const count = Number(plain(row.get('count')));
      if (summary === undefined || count === 0) continue;
      summary.technologies.push({ name: storedString(row.get('name')), count });
    }
    for (const row of await this.#execute(
      'summariseRuns',
      'READ',
      runEndpointTotalsCypher(),
      params,
    )) {
      const summary = summaries.get(storedString(row.get('runId')));
      if (summary === undefined) continue;
      summary.endpointCount = Number(plain(row.get('endpoints')));
      summary.inScopeEndpointCount = Number(plain(row.get('inScope')));
    }

    return new Map(
      [...summaries].map(([runId, summary]) => [runId, finishSummary(runId, summary)]),
    );
  }

  /** One keyset page of a run's endpoints in the ambient tenant, ordered by natural key. */
  async listRunEndpoints(
    runId: string,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<EndpointPage> {
    const parsedRunId = input(runIdSchema, runId);
    const parsedPage = input(pageSchema, page);
    const rows = await this.#execute('listRunEndpoints', 'READ', runEndpointsCypher(), {
      runId: parsedRunId,
      after: parsedPage.after ?? null,
      limit: neo4j.int(parsedPage.limit + 1),
    });
    const nodes = rows
      .slice(0, parsedPage.limit)
      .map((row) => parseStored(nodeProps(row), endpointNodeSchema));
    const last = nodes.at(-1);
    return rows.length > parsedPage.limit && last !== undefined
      ? { nodes, nextCursor: naturalKey(last) }
      : { nodes };
  }

  /**
   * One page of the surface of run `runId` in the ambient tenant, read in one snapshot-consistent transaction. The
   * node set is ranked and capped in Cypher (see {@link runSurfaceRankedCypher}); the edges returned are only those
   * between nodes of the page. A run of another tenant, or an unknown run, has an empty surface.
   */
  async readRunSurface(runId: string, query: RunSurfaceQuery): Promise<RunSurface> {
    const parsedRunId = input(runIdSchema, runId);
    const parsed = input(runSurfaceQuerySchema, query);
    const context = this.#scope('readRunSurface');
    const base = {
      tenantId: context.tenantId,
      runId: parsedRunId,
      kinds: parsed.kinds === undefined ? null : [...parsed.kinds],
      minConfidence: parsed.minConfidence,
      inScopeOnly: parsed.inScopeOnly === true,
    };
    return this.#transact('readRunSurface', 'READ', async (tx) => {
      const read = async (cypher: string, params: Record<string, unknown>) =>
        (await tx.run(cypher, { ...base, ...params })).records;
      const [nodeCountRow] = await read(runSurfaceNodeCountCypher(), {});
      const [edgeCountRow] = await read(runSurfaceEdgeCountCypher(), {});
      const ranked = await read(runSurfaceRankedCypher(), {
        nodeCap: neo4j.int(parsed.nodeCap),
        after: parsed.after ?? null,
        limit: neo4j.int(parsed.limit + 1),
      });
      const pageRows = ranked.slice(0, parsed.limit);
      const nodes = pageRows.map((row) => ({
        node: parseStored(nodeProps(row), surfaceNodeSchema),
        degree: plain(row.get('degree')) as number,
      }));
      const last = nodes.at(-1);
      const hasMore = ranked.length > parsed.limit && last !== undefined;
      const keys = nodes.map((entry) => naturalKey(entry.node));
      const edgeRows =
        keys.length === 0
          ? []
          : await read(runSurfaceEdgesCypher(), {
              keys,
              limit: neo4j.int(parsed.edgeCap + 1),
            });
      const edges = edgeRows.slice(0, parsed.edgeCap).map((row) => ({
        kind: storedEnum(surfaceEdgeKindSchema, row.get('kind')),
        fromKey: storedString(row.get('fromKey')),
        toKey: storedString(row.get('toKey')),
      }));
      return {
        totals: {
          nodes: plain(nodeCountRow?.get('count')) as number,
          edges: plain(edgeCountRow?.get('count')) as number,
        },
        nodes,
        ...(hasMore ? { nextCursor: naturalKey(last.node) } : {}),
        edges,
        edgesTruncated: edgeRows.length > parsed.edgeCap,
      };
    });
  }

  /**
   * Batched, idempotent upsert of the surface nodes of one run (GRAPH-007). Nodes are grouped by kind and written in
   * chunks of `upsertBatchSize`, one transaction per chunk. Everything is validated first (contract, tenant, one run),
   * so a refused batch writes nothing. The write is audited as `graph.surface.upserted` after it commits; a failed
   * audit surfaces as an error, and the upsert can be retried safely because it is idempotent.
   */
  async upsertNodes(nodes: readonly SurfaceNode[]): Promise<UpsertResult> {
    const parsed = input(z.array(surfaceNodeSchema), nodes);
    for (const node of parsed) this.#scope('upsertNodes', node.tenantId);
    if (parsed.length === 0) return emptyUpsert(SURFACE_NODE_KINDS);
    const runId = singleRunId(parsed, 'upsertNodes');
    const context = this.#scope('upsertNodes');
    const audit = this.#requireAudit('upsertNodes');
    return this.#inUpsertSpan(runId, parsed.length, 0, async () => {
      const started = performance.now();
      const counts = new Map<SurfaceNodeKind, UpsertCounts>();
      for (const kind of SURFACE_NODE_KINDS) {
        const rows = parsed.filter((node) => node.kind === kind).map((node) => nodeRow(node));
        if (rows.length === 0) continue;
        const tally = { created: 0, updated: 0 };
        const chunks = chunked(rows, this.#runtime.upsertBatchSize);
        for (const [index, chunk] of chunks.entries()) {
          const records = await this.#upsertChunk(
            'upsertNodes',
            `${kind} node`,
            index,
            chunks.length,
            async (tx) =>
              (await tx.run(upsertNodesCypher(kind), { tenantId: context.tenantId, rows: chunk }))
                .records,
          );
          const created = createdCount(records, chunk.length);
          tally.created += created;
          tally.updated += chunk.length - created;
        }
        counts.set(kind, tally);
        this.#reportCounts('node', kind, tally);
      }
      const result = toUpsertResult(SURFACE_NODE_KINDS, counts);
      this.#metrics.upsertBatchMs?.('node', performance.now() - started);
      await audit.emitAudit(
        upsertAuditInput(context, runId, {
          entity: 'node',
          nodes: parsed.length,
          created: result.created,
          updated: result.updated,
        }),
      );
      return result;
    });
  }

  /**
   * Batched, idempotent upsert of the relationships of one run (GRAPH-007). Each endpoint is matched by natural key;
   * an endpoint that does not exist yet is created as a placeholder (`stub: true`, confidence 0) in the same chunk
   * transaction, so an edge never fails for want of its ends. Chunking, validation and audit work as for
   * {@link upsertNodes}.
   */
  async upsertEdges(edges: readonly SurfaceEdge[]): Promise<EdgeUpsertResult> {
    const parsed = input(z.array(surfaceEdgeSchema), edges);
    for (const edge of parsed) this.#scope('upsertEdges', edge.tenantId);
    if (parsed.length === 0) return { ...emptyUpsert(SURFACE_EDGE_KINDS), stubs: 0 };
    const runId = singleRunId(parsed, 'upsertEdges');
    const context = this.#scope('upsertEdges');
    const audit = this.#requireAudit('upsertEdges');
    return this.#inUpsertSpan(runId, 0, parsed.length, async () => {
      const started = performance.now();
      const counts = new Map<SurfaceEdgeKind, UpsertCounts>();
      let stubs = 0;
      for (const kind of SURFACE_EDGE_KINDS) {
        const rows = parsed.filter((edge) => edge.kind === kind).map((edge) => edgeRow(edge));
        if (rows.length === 0) continue;
        const tally = { created: 0, updated: 0 };
        const chunks = chunked(rows, this.#runtime.upsertBatchSize);
        for (const [index, chunk] of chunks.entries()) {
          // The chunk's placeholder endpoints and its relationships share one transaction.
          const records = await this.#upsertChunk(
            'upsertEdges',
            `${kind} edge`,
            index,
            chunks.length,
            async (tx) => {
              for (const [stubKind, stubRows] of stubRowsOf(chunk)) {
                const [row] = (
                  await tx.run(upsertStubsCypher(stubKind), {
                    tenantId: context.tenantId,
                    rows: stubRows,
                  })
                ).records;
                stubs += plainCount(row?.get('stubs'));
              }
              return (
                await tx.run(upsertEdgesCypher(kind), { tenantId: context.tenantId, rows: chunk })
              ).records;
            },
          );
          const created = createdCount(records, chunk.length);
          tally.created += created;
          tally.updated += chunk.length - created;
        }
        counts.set(kind, tally);
        this.#reportCounts('edge', kind, tally);
      }
      const result = toUpsertResult(SURFACE_EDGE_KINDS, counts);
      this.#metrics.upsertBatchMs?.('edge', performance.now() - started);
      await audit.emitAudit(
        upsertAuditInput(context, runId, {
          entity: 'edge',
          edges: parsed.length,
          created: result.created,
          updated: result.updated,
          stubs,
        }),
      );
      return { ...result, stubs };
    });
  }

  /** Number of nodes of `kind` in the ambient tenant (admin and metrics). */
  async countByTenant(kind: SurfaceNodeKind): Promise<number> {
    const parsedKind = input(surfaceNodeKindSchema, kind);
    const [row] = await this.#execute('countByTenant', 'READ', countNodesCypher(parsedKind), {});
    return plain(row?.get('count')) as number;
  }

  /**
   * Resolves the ambient tenant and refuses the call when there is none (GRAPH_NO_TENANT_CONTEXT) or when
   * `tenantId` names another tenant (GRAPH_TENANT_MISMATCH). Both happen before any query is sent.
   */
  #scope(op: SurfaceGraphOp, tenantId?: string): TenantContext {
    const context = getTenantContext();
    if (context === undefined) {
      this.#refuse(op, 'GRAPH_NO_TENANT_CONTEXT', 'no_tenant_context');
    }
    if (tenantId !== undefined && tenantId.toLowerCase() !== context.tenantId) {
      this.#refuse(op, 'GRAPH_TENANT_MISMATCH', 'tenant_mismatch', context.tenantId);
    }
    return context;
  }

  #refuse(
    op: SurfaceGraphOp,
    code: 'GRAPH_NO_TENANT_CONTEXT' | 'GRAPH_TENANT_MISMATCH',
    reason: string,
    contextTenantId?: string,
  ): never {
    this.#metrics.queryError(code);
    this.#runtime.logger.warn(
      {
        event: 'graph.access.refused',
        op,
        reason,
        ...(contextTenantId === undefined ? {} : { tenantId: hashTenantId(contextTenantId) }),
      },
      'surface graph access refused',
    );
    throw new AppError(code, `surface graph access refused: ${reason}`);
  }

  /** The audit port, or a refusal before any query: a surface change that cannot be audited is never written. */
  #requireAudit(op: SurfaceGraphOp): SurfaceUpsertAudit {
    if (this.#audit === undefined) {
      this.#metrics.queryError('GRAPH_AUDIT_UNBOUND');
      this.#runtime.logger.error(
        { event: 'graph.audit.unbound', op },
        'surface upsert refused: no audit sink is bound',
      );
      throw new AppError('GRAPH_AUDIT_UNBOUND', 'surface upsert refused: no audit sink is bound');
    }
    return this.#audit;
  }

  /** Runs one upsert chunk as its own write transaction. A failure names the chunk and keeps the cause's code. */
  async #upsertChunk<T>(
    op: SurfaceGraphOp,
    label: string,
    index: number,
    total: number,
    work: (tx: GraphTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.#transact(op, 'WRITE', work);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'GRAPH_QUERY_FAILED';
      throw new AppError(
        code,
        `surface upsert failed at ${label} chunk ${index + 1} of ${total}; that chunk was rolled back`,
        { cause: error },
      );
    }
  }

  #reportCounts(entity: 'node' | 'edge', kind: string, tally: UpsertCounts): void {
    this.#metrics.upsertCounted?.(entity, kind, 'created', tally.created);
    this.#metrics.upsertCounted?.(entity, kind, 'updated', tally.updated);
  }

  /** Runs one upsert under a `graph.upsert` span carrying the run and the row counts. */
  #inUpsertSpan<T>(
    runId: string,
    nodeCount: number,
    edgeCount: number,
    work: () => Promise<T>,
  ): Promise<T> {
    return tracer.startActiveSpan('graph.upsert', async (span) => {
      span.setAttributes({ runId, nodeCount, edgeCount });
      try {
        return await work();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Runs one Cypher template for the ambient tenant. The tenant is always bound from the context (it overrides any
   * `tenantId` the caller passed) and a template without `$tenantId` is refused before it is sent.
   */
  async #execute(
    op: SurfaceGraphOp,
    mode: 'READ' | 'WRITE',
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<GraphRecord[]> {
    const context = this.#scope(op);
    if (!cypher.includes('$tenantId')) {
      this.#metrics.queryError('GRAPH_UNSCOPED_QUERY');
      this.#runtime.logger.error(
        { event: 'graph.query.unscoped', op },
        'graph template lacks $tenantId',
      );
      throw new AppError('GRAPH_UNSCOPED_QUERY', 'graph query is not tenant scoped');
    }
    const bound = { ...params, tenantId: context.tenantId };
    return this.#transact(op, mode, async (tx) => (await tx.run(cypher, bound)).records);
  }

  /**
   * Runs `work` in one managed transaction of the graph. Transient failures are retried by the driver's managed
   * transactions, bounded by `maxTransactionRetryTime`; a failure it gave up on is `GRAPH_QUERY_UNAVAILABLE`
   * (retryable), anything else is `GRAPH_QUERY_FAILED`.
   */
  async #transact<T>(
    op: SurfaceGraphOp,
    mode: 'READ' | 'WRITE',
    work: (tx: GraphTransaction) => Promise<T>,
  ): Promise<T> {
    const context = this.#scope(op);
    this.#metrics.queryTotal(op, mode);
    return tracer.startActiveSpan(`graph.repo.${op}`, async (span) => {
      span.setAttribute('tenantId', context.tenantId);
      try {
        return await withSessionOn(this.#runtime, mode, (session: Session) =>
          mode === 'READ' ? session.executeRead(work) : session.executeWrite(work),
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        const code = neo4j.isRetryableError(error)
          ? 'GRAPH_QUERY_UNAVAILABLE'
          : 'GRAPH_QUERY_FAILED';
        this.#metrics.queryError(code);
        this.#runtime.logger.warn(
          {
            event: 'graph.query.failed',
            op,
            code,
            error_name: error instanceof Error ? error.name : 'unknown',
          },
          'surface graph query failed',
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw new AppError(code, 'surface graph query failed', { cause: error });
      } finally {
        span.end();
      }
    });
  }
}

/** The part of a driver transaction the repository uses. */
interface GraphTransaction {
  run(text: string, values: Record<string, unknown>): Promise<{ records: GraphRecord[] }>;
}

interface MutableSummary {
  nodeCounts: KindCount<SurfaceNodeKind>[];
  edgeCounts: KindCount<SurfaceEdgeKind>[];
  technologies: TechnologyCount[];
  endpointCount: number;
  inScopeEndpointCount: number;
}

function emptyMutableSummary(): MutableSummary {
  return {
    nodeCounts: [],
    edgeCounts: [],
    technologies: [],
    endpointCount: 0,
    inScopeEndpointCount: 0,
  };
}

/** Orders the counts (kinds ascending; technologies by count, then name) and caps the technology list. */
function finishSummary(runId: string, summary: MutableSummary): RunSurfaceSummary {
  const byKind = <K extends string>(a: KindCount<K>, b: KindCount<K>): number =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  const technologies = [...summary.technologies]
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, TOP_TECHNOLOGIES_MAX);
  return {
    runId,
    nodeCounts: [...summary.nodeCounts].sort(byKind),
    edgeCounts: [...summary.edgeCounts].sort(byKind),
    topTechnologies: technologies,
    endpointCount: summary.endpointCount,
    inScopeEndpointCount: summary.inScopeEndpointCount,
  };
}

/** Splits `items` into consecutive chunks of at most `size`. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** A value of a node or edge, as the upsert merge sees it. */
interface ProvenanceCarrier {
  readonly provenance: { readonly runId: string };
}

/** Every item of an upsert must carry one run id; a mixed batch is refused, since its audit event names one run. */
function singleRunId(items: readonly ProvenanceCarrier[], op: SurfaceGraphOp): string {
  const [first] = items;
  if (first === undefined) {
    throw new AppError('VALIDATION_FAILED', 'an upsert needs at least one item');
  }
  const runId = first.provenance.runId;
  if (items.some((item) => item.provenance.runId !== runId)) {
    throw new AppError('VALIDATION_FAILED', `${op} takes one run per call; split the batch by run`);
  }
  return runId;
}

/** Rows of an upsert with the natural key, the stored facts and the provenance the merge needs. */
interface UpsertRow {
  readonly naturalKey: string;
  readonly props: Record<string, unknown>;
  readonly facts: Record<string, unknown>;
  readonly confidence: number;
  readonly lastSeenAt: string;
  readonly runId: string;
  readonly observationKey: string;
  readonly observation: Record<string, unknown>;
}

/** The upsert row of a node: its facts, its provenance and its (run, natural key, tool) observation. */
function nodeRow(node: SurfaceNode): UpsertRow {
  const key = naturalKey(node);
  const facts = { ...storedFacts(node), naturalKey: key };
  const observationKey = JSON.stringify([node.provenance.runId, key, node.provenance.tool ?? '']);
  return {
    naturalKey: key,
    props: { ...facts, ...storedProvenance(node) },
    facts,
    confidence: node.provenance.confidence,
    lastSeenAt: node.provenance.lastSeenAt,
    runId: node.provenance.runId,
    observationKey,
    observation: definedOnly({
      observationKey,
      runId: node.provenance.runId,
      persona: node.provenance.persona,
      tool: node.provenance.tool,
      confidence: node.provenance.confidence,
      at: node.provenance.lastSeenAt,
    }),
  };
}

/** The upsert row of a relationship, addressed by its endpoints. */
interface EdgeRow {
  readonly fromKey: string;
  readonly toKey: string;
  readonly props: Record<string, unknown>;
  readonly facts: Record<string, unknown>;
  readonly confidence: number;
  readonly lastSeenAt: string;
  readonly runId: string;
}

function edgeRow(edge: SurfaceEdge): EdgeRow {
  return {
    fromKey: edge.fromKey,
    toKey: edge.toKey,
    props: storedProps(edge),
    facts: storedFacts(edge),
    confidence: edge.provenance.confidence,
    lastSeenAt: edge.provenance.lastSeenAt,
    runId: edge.provenance.runId,
  };
}

/** The kind of a node key: its prefix (`host:`, `service:`...). The edge contract already fixed the prefix. */
function keyKind(key: string): SurfaceNodeKind {
  return input(surfaceNodeKindSchema, key.slice(0, key.indexOf(':')));
}

/** The placeholder nodes a chunk of edges needs, grouped by kind and de-duplicated by natural key. */
function stubRowsOf(chunk: readonly EdgeRow[]): Map<SurfaceNodeKind, Record<string, unknown>[]> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of chunk) {
    for (const key of [row.fromKey, row.toKey]) {
      if (byKey.has(key)) continue;
      byKey.set(key, {
        naturalKey: key,
        kind: keyKind(key),
        runId: row.runId,
        firstSeenAt: row.props.provenance_firstSeenAt,
        lastSeenAt: row.lastSeenAt,
      });
    }
  }
  const grouped = new Map<SurfaceNodeKind, Record<string, unknown>[]>();
  for (const [key, stub] of byKey) {
    const kind = keyKind(key);
    grouped.set(kind, [...(grouped.get(kind) ?? []), stub]);
  }
  return grouped;
}

/** How many of a chunk's rows were created. A row count that differs from the chunk is a fault, never a silent pass. */
function createdCount(records: readonly GraphRecord[], expected: number): number {
  if (records.length !== expected) {
    throw new AppError('GRAPH_QUERY_FAILED', 'surface upsert wrote an unexpected number of rows');
  }
  return records.filter((record) => record.get('created') === true).length;
}

/** Reads a count returned by Cypher (an integer, possibly a driver Integer). */
function plainCount(value: unknown): number {
  const count = plain(value);
  return typeof count === 'number' ? count : 0;
}

/** A zeroed upsert result over the given kinds. */
function emptyUpsert<K extends string>(kinds: readonly K[]): UpsertResult<K> {
  return toUpsertResult(kinds, new Map(kinds.map((kind) => [kind, { created: 0, updated: 0 }])));
}

/** Totals and per-kind counts of an upsert, every kind present. */
function toUpsertResult<K extends string>(
  kinds: readonly K[],
  counts: ReadonlyMap<K, UpsertCounts>,
): UpsertResult<K> {
  const byKind = Object.fromEntries(
    kinds.map((kind) => [kind, counts.get(kind) ?? { created: 0, updated: 0 }]),
  ) as Record<K, UpsertCounts>;
  const values = Object.values<UpsertCounts>(byKind);
  return {
    created: values.reduce((sum, count) => sum + count.created, 0),
    updated: values.reduce((sum, count) => sum + count.updated, 0),
    byKind,
  };
}

/** Maps the tenant actor to the audit actor (a run acts as a service). */
function auditActorOf(actor: TenantActor): AuditActor {
  return actor.type === 'user' ? { type: 'user', id: actor.id } : { type: 'service', id: actor.id };
}

/** The `graph.surface.upserted` event of one upsert call: the run, the counts, never the graph content. */
function upsertAuditInput(
  context: TenantContext,
  runId: string,
  metadata: Record<string, number | string>,
): AuditEventInput {
  return {
    tenantId: context.tenantId,
    action: UPSERT_ACTION,
    actor: auditActorOf(context.actor),
    target: { type: 'run', id: runId },
    outcome: 'success',
    runId,
    metadata,
  };
}

/** Options for {@link withTenantGraph}. */
export interface WithTenantGraphOptions {
  /** The graph runtime. Default: the process runtime (`getGraph()`). */
  readonly runtime?: GraphRuntime;
  readonly metrics?: SurfaceGraphMetrics;
  /** Who acts. Default: the surface-graph service identity. */
  readonly actor?: TenantActor;
  /** The audit port of surface upserts; a write without it is refused. */
  readonly audit?: SurfaceUpsertAudit;
}

/**
 * Runs `fn` with `tenantId` as the ambient tenant and a repository bound to it. Entry points (API, worker, broker)
 * establish the context from a validated principal; this wrapper is the same mechanism for them and for tests. An
 * invalid tenant id, or a nested call for another tenant, is refused by the tenant-context module.
 */
export async function withTenantGraph<T>(
  tenantId: string,
  fn: (repository: SurfaceGraphRepository) => Promise<T>,
  options: WithTenantGraphOptions = {},
): Promise<T> {
  const runtime = options.runtime ?? getGraph();
  const actor = options.actor ?? SERVICE_ACTOR;
  return runWithTenantContext({ tenantId, actor }, () =>
    fn(
      new SurfaceGraphRepository(runtime, {
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(options.audit ? { audit: options.audit } : {}),
      }),
    ),
  );
}
