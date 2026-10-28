import { Counter, exponentialBuckets, Histogram, type Registry } from 'prom-client';

/** Cost buckets: 1, then 4x per step, so a typical page and a rejected flood both land in a bucket. */
const COMPLEXITY_BUCKET_COUNT = 8;
const COMPLEXITY_BUCKET_FACTOR = 4;
const COMPLEXITY_BUCKETS = exponentialBuckets(1, COMPLEXITY_BUCKET_FACTOR, COMPLEXITY_BUCKET_COUNT);

/** GraphQL metrics (API-009), on the app's registry. */
export interface GraphqlMetrics {
  /** `graphql_requests_total{operation}`: operations that reached validation (`anonymous` when unnamed). */
  readonly requests: Counter<'operation'>;
  /** `graphql_complexity`: estimated cost of each analysed operation. */
  readonly complexity: Histogram;
  /** `graphql_rejected_total{reason}`: operations refused by a query limit (`depth`, `complexity`, `aliases`). */
  readonly rejected: Counter<'reason'>;
}

export function createGraphqlMetrics(registry: Registry): GraphqlMetrics {
  return {
    requests: new Counter({
      name: 'graphql_requests_total',
      help: 'GraphQL operations that reached validation, by operation name.',
      labelNames: ['operation'],
      registers: [registry],
    }),
    complexity: new Histogram({
      name: 'graphql_complexity',
      help: 'Estimated cost of each GraphQL operation.',
      buckets: COMPLEXITY_BUCKETS,
      registers: [registry],
    }),
    rejected: new Counter({
      name: 'graphql_rejected_total',
      help: 'GraphQL operations refused by a depth, complexity or alias limit, by reason.',
      labelNames: ['reason'],
      registers: [registry],
    }),
  };
}
