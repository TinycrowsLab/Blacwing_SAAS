import { createHash } from 'node:crypto';

import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

import {
  naturalKey,
  type SurfaceEdgeView,
  type SurfaceNode,
  type SurfaceNodeView,
  uuidV7Schema,
  type AuditActor,
  type SurfaceRunView,
} from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import {
  AppError,
  ForbiddenError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';

import { GRAPH_VIZ_MAX_EDGES, GRAPH_VIZ_MAX_NODES } from './limits.js';
import { parseSurfaceQuery } from './query.js';
import { TRACER_NAME } from '../bootstrap/request-context.js';

import type { SurfaceMetrics } from './metrics.js';
import type { SurfacePolicyEngine } from './policy.js';
import type {
  SurfaceAuditWriter,
  SurfaceGraphReader,
  SurfacePrincipal,
  SurfaceRunReader,
} from './ports.js';
import type { CursorCodec } from '../pagination/cursor.js';
import type { Logger } from '@blackwing/logger';
import type { RunSurface } from '@blackwing/memory';

/** The audit action of a served surface read (appended to the catalogue for GRAPH-006). */
export const RUN_SURFACE_VIEWED_ACTION = 'run.surface.viewed';
/** The trace span of one surface read. */
export const RUN_SURFACE_SPAN = 'api.run.surface';

/** Longest label carried for a node in the view. */
const LABEL_MAX = 256;
const runIdSchema = uuidV7Schema;

/** Everything the surface view composes. Every dependency is a port; the composition root supplies them. */
export interface SurfaceServiceDeps {
  readonly runs: SurfaceRunReader;
  readonly graph: SurfaceGraphReader;
  readonly policy: SurfacePolicyEngine;
  readonly audit: SurfaceAuditWriter;
  /** Signs and verifies page cursors (`API_CURSOR_SECRET`, API-005). */
  readonly cursors: CursorCodec;
  readonly metrics: SurfaceMetrics;
  /** Hard caps of the view. Default: {@link GRAPH_VIZ_MAX_NODES} and {@link GRAPH_VIZ_MAX_EDGES}. */
  readonly nodeCap?: number;
  readonly edgeCap?: number;
  /** Milliseconds, for the latency metric. Default: `Date.now`. */
  readonly now?: () => number;
  /** Structured log of each served read: counts and the run id, never graph content. */
  readonly logger?: Pick<Logger, 'info'>;
}

/** A short, human-readable label of a node: the part an analyst scans for, never a banner or an example. */
function labelOf(node: SurfaceNode): string {
  switch (node.kind) {
    case 'asset':
      return node.assetId;
    case 'host':
      return node.hostname;
    case 'service':
      return `${node.hostname}:${String(node.port)}/${node.protocol}`;
    case 'technology':
      return node.version === undefined ? node.name : `${node.name} ${node.version}`;
    case 'endpoint':
      return `${node.method} ${node.pathTemplate}`;
    case 'parameter':
      return `${node.location}:${node.name}`;
    case 'role':
      return node.roleName;
  }
}

function clip(value: string): string {
  return value.length <= LABEL_MAX ? value : `${value.slice(0, LABEL_MAX - 1)}…`;
}

function nodeView(node: SurfaceNode, degree: number): SurfaceNodeView {
  return {
    id: naturalKey(node),
    kind: node.kind,
    label: clip(labelOf(node)),
    ...(node.kind === 'host' ? { inScope: node.inScope } : {}),
    confidence: node.provenance.confidence,
    degree,
  };
}

/** The cursor signature: a cursor is valid only for the run, the kinds and the confidence it was issued for. */
function signatureOf(
  runId: string,
  kinds: readonly string[] | undefined,
  minConfidence: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ runId, kinds: kinds ?? null, minConfidence }))
    .digest('base64url');
}

function notPermitted(): ForbiddenError {
  return new ForbiddenError("you are not permitted to read this run's surface");
}

/**
 * The console surface view of one run (GRAPH-006): authenticate-then-authorise, validate the query, read one bounded
 * page of the graph, audit the read, answer. Errors are `AppError`s, mapped to RFC 9457 by the route.
 *
 * Authorisation is layered: `run:read` (RBAC), then the run must exist in the caller's tenant (`RUN_NOT_FOUND`
 * otherwise, uniform for a missing and a foreign run), then the Cedar resource check (`FORBIDDEN`).
 */
export class SurfaceService {
  readonly #deps: SurfaceServiceDeps;
  readonly #nodeCap: number;
  readonly #edgeCap: number;
  readonly #now: () => number;
  readonly #tracer = trace.getTracer(TRACER_NAME);

  constructor(deps: SurfaceServiceDeps) {
    this.#deps = deps;
    this.#nodeCap = deps.nodeCap ?? GRAPH_VIZ_MAX_NODES;
    this.#edgeCap = deps.edgeCap ?? GRAPH_VIZ_MAX_EDGES;
    this.#now = deps.now ?? Date.now;
  }

  /** The view of run `runId` for `principal`, at most one page of at most the node and edge caps. */
  async get(
    principal: SurfacePrincipal,
    runId: string,
    rawQuery: Readonly<Record<string, unknown>>,
  ): Promise<SurfaceRunView> {
    const started = this.#now();
    const span = this.#tracer.startSpan(RUN_SURFACE_SPAN, { attributes: { 'bw.run_id': runId } });
    let outcome: 'ok' | 'error' = 'error';
    try {
      const view = await this.#serve(principal, runId, rawQuery, span);
      outcome = 'ok';
      return view;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      this.#deps.metrics.requestMs.observe({ outcome }, this.#now() - started);
      span.end();
    }
  }

  async #serve(
    principal: SurfacePrincipal,
    runId: string,
    rawQuery: Readonly<Record<string, unknown>>,
    span: Span,
  ): Promise<SurfaceRunView> {
    const tenantId = principal.tenantId;
    if (tenantId === null || tenantId === '') {
      throw new TenantContextMissingError('a tenant context is required to read a run surface');
    }
    if (!runIdSchema.safeParse(runId).success) {
      throw new ValidationError('runId must be a lowercase UUIDv7');
    }
    const query = parseSurfaceQuery(rawQuery);
    if (!hasPermission(principal.roles, 'run:read')) throw notPermitted();

    const run = await this.#deps.runs.getRun(tenantId, runId);
    // Missing and foreign runs take the same answer: no existence oracle (§8.6).
    if (run?.tenantId !== tenantId) {
      throw new AppError('RUN_NOT_FOUND', 'run not found');
    }
    const allowed = this.#deps.policy.allows(
      { userId: principal.id, tenantId, roles: principal.roles },
      { id: run.id, tenantId: run.tenantId, ownerUserIds: run.ownerUserIds },
    );
    if (!allowed) throw notPermitted();

    const signature = signatureOf(runId, query.kinds, query.minConfidence);
    const after =
      query.cursor === undefined ? undefined : this.#decodeCursor(query.cursor, signature);
    const surface = await this.#deps.graph.readRunSurface(tenantId, runId, {
      ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
      minConfidence: query.minConfidence,
      ...(after === undefined ? {} : { after }),
      limit: query.limit,
      nodeCap: this.#nodeCap,
      edgeCap: this.#edgeCap,
    });

    await this.#deps.audit({
      tenantId,
      action: RUN_SURFACE_VIEWED_ACTION,
      actor: actorOf(principal),
      target: { type: 'run', id: runId },
      outcome: 'success',
      runId,
    });

    const view = this.#view(run.state, surface, signature);
    span.setAttributes({
      'bw.graph_viz.nodes': view.nodes.length,
      'bw.graph_viz.edges': view.edges.length,
      'bw.graph_viz.truncated': view.truncated,
    });
    this.#deps.metrics.nodes.observe(view.nodes.length);
    this.#deps.metrics.edges.observe(view.edges.length);
    if (view.truncated) this.#deps.metrics.truncated.inc();
    this.#deps.logger?.info(
      {
        event: 'run.surface.served',
        runId,
        nodes: view.nodes.length,
        edges: view.edges.length,
        truncated: view.truncated,
      },
      'run surface served',
    );
    return view;
  }

  #view(state: SurfaceRunView['runState'], surface: RunSurface, signature: string): SurfaceRunView {
    const nodes = surface.nodes.map((entry) => nodeView(entry.node, entry.degree));
    const ids = new Set(nodes.map((node) => node.id));
    // The graph returns only edges between page nodes; the view repeats the rule so it can never hold a dangling end.
    const edges: SurfaceEdgeView[] = surface.edges
      .filter((edge) => ids.has(edge.fromKey) && ids.has(edge.toKey))
      .map((edge) => ({ kind: edge.kind, from: edge.fromKey, to: edge.toKey }));
    const last = nodes.at(-1);
    const hasNextPage = surface.nextCursor !== undefined;
    return {
      nodes,
      edges,
      totals: { nodes: surface.totals.nodes, edges: surface.totals.edges },
      truncated:
        surface.totals.nodes > this.#nodeCap ||
        surface.totals.edges > this.#edgeCap ||
        surface.edgesTruncated,
      pageInfo: {
        ...(last === undefined ? {} : { endCursor: this.#encodeCursor(last.id, signature) }),
        hasNextPage,
      },
      clusteredBy: 'asset',
      runState: state,
    };
  }

  #encodeCursor(key: string, signature: string): string {
    return this.#deps.cursors.encode({ k: [key], d: 'asc', s: signature });
  }

  /** Verifies a cursor for this run and filter. Every failure, the codec's included, is `INVALID_CURSOR` (400). */
  #decodeCursor(cursor: string, signature: string): string {
    let key: string | number | undefined;
    try {
      [key] = this.#deps.cursors.decode(cursor, { d: 'asc', s: signature }).k;
    } catch (error) {
      throw new AppError('INVALID_CURSOR', 'invalid cursor', { cause: error });
    }
    if (typeof key !== 'string') throw new AppError('INVALID_CURSOR', 'invalid cursor');
    return key;
  }
}

/** The audit actor of a read: the user or the service account that made it. */
function actorOf(principal: SurfacePrincipal): AuditActor {
  return principal.type === 'service'
    ? { type: 'service', id: principal.id }
    : { type: 'user', id: principal.id };
}
