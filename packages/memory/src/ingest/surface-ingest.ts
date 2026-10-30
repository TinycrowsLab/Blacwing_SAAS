import { trace } from '@opentelemetry/api';

import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import {
  type ParsedArtefactInput,
  type SurfaceMapContextInput,
  toSurfaceGraph,
} from './surface-mapper.js';
import {
  type EdgeUpsertResult,
  type UpsertCounts,
  type UpsertResult,
  withTenantGraph,
  type WithTenantGraphOptions,
} from '../graph/repository.js';

import type { SurfaceEdgeKind, SurfaceNode, SurfaceNodeKind } from '@blackwing/contracts';

/** The domain event an artefact's surface write emits (INGEST-001, §8.8). */
export const INGEST_SURFACE_WRITTEN = 'ingest.surface.written';

const logger = createLogger('ingest-surface');
const tracer = trace.getTracer('@blackwing/memory');

/** Per-kind counts of one write. A kind that changed nothing is left out. */
export type IngestCountsByKind = Readonly<Record<SurfaceNodeKind | SurfaceEdgeKind, UpsertCounts>>;

export interface IngestSurfaceWritten {
  readonly runId: string;
  readonly tenantId: string;
  readonly manifestId: string;
  /** Rows created or refreshed, nodes and relationships together. Zero for an empty artefact. */
  readonly count: number;
  readonly byKind: Partial<IngestCountsByKind>;
}

/** The event port. The composition root binds it to the event bus; this module publishes and never subscribes. */
export interface IngestSurfaceEvents {
  publish(event: IngestSurfaceWritten): Promise<void>;
}

/**
 * Metrics of the spec-ingestion mapper: `ingest_surface_mapped_nodes_total{kind}` and
 * `ingest_surface_map_errors_total{reason}`. The composition root binds them to its metrics registry.
 */
export interface IngestSurfaceMetrics {
  mappedNodes?(kind: SurfaceNodeKind, count: number): void;
  mapError?(reason: string): void;
}

export interface IngestSurfaceOptions {
  /** The graph runtime, actor and audit port of the write (see {@link withTenantGraph}). */
  readonly graph?: WithTenantGraphOptions;
  readonly events: IngestSurfaceEvents;
  readonly metrics?: IngestSurfaceMetrics;
}

export interface IngestSurfaceResult {
  readonly nodes: UpsertResult;
  readonly edges: EdgeUpsertResult;
}

/**
 * Maps one parsed artefact to the surface graph and writes it through the GRAPH-005 upsert, inside the tenant's
 * context. A refused artefact writes nothing and throws. An empty artefact writes nothing and still publishes
 * `ingest.surface.written` with a count of zero. Re-ingesting the same artefact creates nothing (the upsert is keyed on
 * the natural key), so a retried activity is safe.
 */
export async function ingestSurfaceArtefact(
  artefact: ParsedArtefactInput,
  context: SurfaceMapContextInput,
  options: IngestSurfaceOptions,
): Promise<IngestSurfaceResult> {
  const graph = tracer.startActiveSpan('ingest.surface.map', (span) => {
    try {
      return toSurfaceGraph(artefact, context);
    } catch (error) {
      options.metrics?.mapError?.(error instanceof AppError ? error.code : 'UNEXPECTED');
      span.recordException(error instanceof Error ? error : String(error));
      throw error;
    } finally {
      span.end();
    }
  });
  for (const [kind, count] of mappedCounts(graph.nodes)) {
    options.metrics?.mappedNodes?.(kind, count);
  }

  const { runId, tenantId, manifestId } = context;
  const result = await withTenantGraph(
    tenantId,
    async (repository) => ({
      nodes: await repository.upsertNodes(graph.nodes),
      edges: await repository.upsertEdges(graph.edges),
    }),
    options.graph,
  );

  const byKind = changedByKind(result.nodes, result.edges);
  const count = Object.values<UpsertCounts>(byKind).reduce(
    (sum, counts) => sum + counts.created + counts.updated,
    0,
  );
  const event: IngestSurfaceWritten = { runId, tenantId, manifestId, count, byKind };
  await options.events.publish(event);
  logger.info({ runId, tenantId, manifestId, count, byKind }, INGEST_SURFACE_WRITTEN);
  return result;
}

/** How many nodes of each kind a mapped graph holds. */
function mappedCounts(nodes: readonly SurfaceNode[]): Map<SurfaceNodeKind, number> {
  const counts = new Map<SurfaceNodeKind, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return counts;
}

/** The node and relationship counts of a write, merged by kind. Kinds never overlap, so nothing is summed twice. */
function changedByKind(nodes: UpsertResult, edges: EdgeUpsertResult): Partial<IngestCountsByKind> {
  const changed: Partial<Record<SurfaceNodeKind | SurfaceEdgeKind, UpsertCounts>> = {};
  for (const source of [nodes.byKind, edges.byKind] as const) {
    for (const [kind, counts] of Object.entries<UpsertCounts>(source)) {
      if (counts.created + counts.updated > 0) {
        changed[kind as SurfaceNodeKind | SurfaceEdgeKind] = counts;
      }
    }
  }
  return changed;
}
