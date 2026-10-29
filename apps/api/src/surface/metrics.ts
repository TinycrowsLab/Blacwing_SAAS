import { Counter, exponentialBuckets, Histogram, Registry } from 'prom-client';

/** Surface view metrics (GRAPH-006 observability). One private registry per instance. */
export interface SurfaceMetrics {
  readonly registry: Registry;
  /** `graph_viz_request_ms{outcome}`: time to serve one surface read (`ok` or `error`). */
  readonly requestMs: Histogram<'outcome'>;
  /** `graph_viz_truncated_total`: reads whose surface exceeded a cap and was served as a subset. */
  readonly truncated: Counter;
  /** `graph_viz_nodes`: nodes in one response. */
  readonly nodes: Histogram;
  /** `graph_viz_edges`: edges in one response. */
  readonly edges: Histogram;
}

/** Size buckets: 1 doubling up to 4096, which covers the 2000 node and 4000 edge caps. */
const SIZE_BUCKET_COUNT = 13;

export function createSurfaceMetrics(registry: Registry = new Registry()): SurfaceMetrics {
  return {
    registry,
    requestMs: new Histogram({
      name: 'graph_viz_request_ms',
      help: 'Time to serve one run surface read, in milliseconds, by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    truncated: new Counter({
      name: 'graph_viz_truncated_total',
      help: 'Run surface reads served as a capped subset of a larger surface.',
      registers: [registry],
    }),
    nodes: new Histogram({
      name: 'graph_viz_nodes',
      help: 'Nodes in one run surface response.',
      buckets: exponentialBuckets(1, 2, SIZE_BUCKET_COUNT),
      registers: [registry],
    }),
    edges: new Histogram({
      name: 'graph_viz_edges',
      help: 'Edges in one run surface response.',
      buckets: exponentialBuckets(1, 2, SIZE_BUCKET_COUNT),
      registers: [registry],
    }),
  };
}
