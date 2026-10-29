import { z } from 'zod';

import { runStateSchema } from './entities/run.js';
import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';
import { surfaceEdgeKindSchema, surfaceNodeKindSchema } from './surface.js';

/**
 * The console view of a run's surface graph (GRAPH-006, CONTEXT_PACK §3.1, §9). The wire shape is a display
 * projection of the GRAPH-001 contracts: it carries a short label, never a raw banner, example or evidence body,
 * so the shape can evolve for the UI without touching the graph contract (`surface.ts`).
 */

/** The layout hint sent to the client: nodes cluster by the asset they belong to. */
export const SURFACE_VIEW_CLUSTERED_BY = 'asset';

/** Longest node id or edge end: the natural-key bound of the graph contract (`surface.ts`). */
const VIEW_KEY_MAX = 4096;

/** Longest label carried for one node. */
export const SURFACE_VIEW_LABEL_MAX = 256;

/**
 * How a node was found: the run, the tool that reported it and when. A summary for the inspector, never the raw
 * evidence, the agent session or the persona (those stay in the graph).
 */
const surfaceNodeProvenanceViewSchema = z.strictObject({
  runId: uuidV7Schema,
  tool: z.string().min(1).max(SURFACE_VIEW_LABEL_MAX).optional(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});

/** One node of the view. `id` is the node's natural key, unique within the tenant. */
export const surfaceNodeViewSchema = z.strictObject({
  id: z.string().min(1).max(VIEW_KEY_MAX),
  kind: surfaceNodeKindSchema,
  label: z.string().min(1).max(SURFACE_VIEW_LABEL_MAX),
  inScope: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
  /** Edges of this node among the nodes of the view (the basis of the server-side selection). */
  degree: z.int().min(0),
  provenance: surfaceNodeProvenanceViewSchema,
});
export type SurfaceNodeView = z.infer<typeof surfaceNodeViewSchema>;

/** One directed edge of the view. `from` and `to` are node ids present in the same page. */
export const surfaceEdgeViewSchema = z.strictObject({
  kind: surfaceEdgeKindSchema,
  from: z.string().min(1).max(VIEW_KEY_MAX),
  to: z.string().min(1).max(VIEW_KEY_MAX),
});
export type SurfaceEdgeView = z.infer<typeof surfaceEdgeViewSchema>;

/** The response of `GET /v1/runs/{runId}/surface`. */
export const surfaceRunViewSchema = z.strictObject({
  nodes: z.array(surfaceNodeViewSchema),
  edges: z.array(surfaceEdgeViewSchema),
  /** Full counts of the matching surface, before any cap or page. */
  totals: z.strictObject({ nodes: z.int().min(0), edges: z.int().min(0) }),
  /** True when the surface exceeds the node or edge cap, so the view holds a selected subset. */
  truncated: z.boolean(),
  pageInfo: z.strictObject({
    endCursor: z.string().min(1).optional(),
    hasNextPage: z.boolean(),
  }),
  clusteredBy: z.literal(SURFACE_VIEW_CLUSTERED_BY),
  /** The run's state now. A finished run (killed or completed) stays viewable with its last-known surface. */
  runState: runStateSchema,
});
export type SurfaceRunView = z.infer<typeof surfaceRunViewSchema>;
