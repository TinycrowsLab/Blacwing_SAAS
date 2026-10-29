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
  listNodesCypher,
  mergeEdgeCypher,
  mergeNodeCypher,
  neighboursCypher,
} from './cypher.js';
import { getGraph, type GraphRuntime, withSessionOn } from './driver.js';

/** Hard cap on the nodes one `getNeighbours` call returns; a larger result is reported as truncated. */
export const NEIGHBOUR_LIMIT = 100;
/** Largest page `listNodes` returns. */
export const LIST_PAGE_MAX = 200;
const KEY_MAX = 4096;
const FILTER_KEY = /^[a-z][A-Za-z0-9]*$/;
const SERVICE_ACTOR: TenantActor = Object.freeze({ type: 'service', id: 'surface-graph' });
const PROVENANCE_PREFIX = 'provenance_';

const tracer = trace.getTracer('@blackwing/memory');

/** Repository operations, as named in the `graph.repo.<op>` span and the `op` metric label. */
export type SurfaceGraphOp =
  'writeNode' | 'writeEdge' | 'getNode' | 'listNodes' | 'getNeighbours' | 'countByTenant';

/** Counters (OBS wires these to Prometheus; the default is a no-op). */
export interface SurfaceGraphMetrics {
  /** `graph_query_total{op,mode}`. */
  queryTotal(op: SurfaceGraphOp, mode: 'READ' | 'WRITE'): void;
  /** `graph_query_errors_total{code}`. */
  queryError(code: string): void;
}

const NOOP_METRICS: SurfaceGraphMetrics = {
  queryTotal: () => undefined,
  queryError: () => undefined,
};

/** Options for {@link SurfaceGraphRepository}. */
export interface SurfaceGraphOptions {
  readonly metrics?: SurfaceGraphMetrics;
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

const keySchema = z.string().min(1).max(KEY_MAX);
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
  const { provenance, ...rest } = value;
  const props: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(rest)) {
    if (field !== undefined) props[key] = field;
  }
  for (const [key, field] of Object.entries(provenance)) {
    if (field !== undefined) props[`${PROVENANCE_PREFIX}${key}`] = field;
  }
  return props;
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

  constructor(runtime: GraphRuntime, options: SurfaceGraphOptions = {}) {
    this.#runtime = runtime;
    this.#metrics = options.metrics ?? NOOP_METRICS;
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

  /**
   * Runs one Cypher template for the ambient tenant. The tenant is always bound from the context (it overrides any
   * `tenantId` the caller passed) and a template without `$tenantId` is refused before it is sent. Transient
   * failures are retried by the driver's managed transactions, bounded by `maxTransactionRetryTime`; a failure it
   * gave up on is `GRAPH_QUERY_UNAVAILABLE` (retryable), anything else is `GRAPH_QUERY_FAILED`.
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
    this.#metrics.queryTotal(op, mode);
    return tracer.startActiveSpan(`graph.repo.${op}`, async (span) => {
      span.setAttribute('tenantId', context.tenantId);
      try {
        return await withSessionOn(this.#runtime, mode, (session: Session) => {
          const work = async (tx: {
            run(text: string, values: Record<string, unknown>): Promise<{ records: GraphRecord[] }>;
          }) => (await tx.run(cypher, bound)).records;
          return mode === 'READ' ? session.executeRead(work) : session.executeWrite(work);
        });
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

/** Options for {@link withTenantGraph}. */
export interface WithTenantGraphOptions {
  /** The graph runtime. Default: the process runtime (`getGraph()`). */
  readonly runtime?: GraphRuntime;
  readonly metrics?: SurfaceGraphMetrics;
  /** Who acts. Default: the surface-graph service identity. */
  readonly actor?: TenantActor;
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
      }),
    ),
  );
}
