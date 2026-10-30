import { Histogram, exponentialBuckets, type Registry } from 'prom-client';

/** The dashboard reads, by GraphQL root field. Labels are this bounded set, never ids. */
export type DashboardQueryName = 'summary' | 'trend' | 'coverage' | 'connection';

/** Metrics of the dashboard reads (DASH-001), on the app's registry. */
export interface DashboardMetrics {
  /** Records one answered read: its wall time and how many result rows it carried. */
  readonly observe: (query: DashboardQueryName, durationMs: number, rows: number) => void;
}

/** Duration buckets: 5 ms doubling, nine buckets (5 ms to 1.28 s), around the 500 ms slow-query line. */
const DURATION_FIRST_BUCKET_MS = 5;
const DURATION_BUCKET_COUNT = 9;
const DURATION_BUCKETS_MS = exponentialBuckets(DURATION_FIRST_BUCKET_MS, 2, DURATION_BUCKET_COUNT);
/** Row buckets: 0, then 1, 4, 16 ... quadrupling to about 65 thousand rows (a summary of a large tenant). */
const ROW_FIRST_BUCKET = 1;
const ROW_BUCKET_FACTOR = 4;
const ROW_BUCKET_COUNT = 9;
const ROW_BUCKETS = [
  0,
  ...exponentialBuckets(ROW_FIRST_BUCKET, ROW_BUCKET_FACTOR, ROW_BUCKET_COUNT),
];

/** `graphql_dashboard_query_duration_ms{query}` and `graphql_dashboard_rows{query}` on the app's registry. */
export function createDashboardMetrics(registry: Registry): DashboardMetrics {
  const duration = new Histogram({
    name: 'graphql_dashboard_query_duration_ms',
    help: 'Time a dashboard GraphQL read took, in milliseconds, by query.',
    labelNames: ['query'],
    buckets: DURATION_BUCKETS_MS,
    registers: [registry],
  });
  const rows = new Histogram({
    name: 'graphql_dashboard_rows',
    help: 'Result rows a dashboard GraphQL read carried (findings aggregated for a summary), by query.',
    labelNames: ['query'],
    buckets: ROW_BUCKETS,
    registers: [registry],
  });
  return {
    observe: (query, durationMs, count) => {
      duration.observe({ query }, durationMs);
      rows.observe({ query }, count);
    },
  };
}
