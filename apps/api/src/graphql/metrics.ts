import { Counter, exponentialBuckets, Histogram, type Registry } from 'prom-client';

/** Cost buckets: 1, then 4x per step, so a typical page and a rejected flood both land in a bucket. */
const COMPLEXITY_BUCKET_COUNT = 8;
const COMPLEXITY_BUCKET_FACTOR = 4;
const COMPLEXITY_BUCKETS = exponentialBuckets(1, COMPLEXITY_BUCKET_FACTOR, COMPLEXITY_BUCKET_COUNT);
/** Resolver time buckets, in milliseconds: 1, 3, 9, ... 729 (a 3x ladder). */
const RESOLVER_BUCKET_START_MS = 1;
const RESOLVER_BUCKET_FACTOR = 3;
const RESOLVER_BUCKET_COUNT = 7;
const RESOLVER_MS_BUCKETS = exponentialBuckets(
  RESOLVER_BUCKET_START_MS,
  RESOLVER_BUCKET_FACTOR,
  RESOLVER_BUCKET_COUNT,
);
/** DataLoader batch sizes: one key up to a full page of batched keys (1, 2, 4, ... 128, then 200). */
const BATCH_BUCKET_START = 1;
const BATCH_BUCKET_FACTOR = 2;
const BATCH_BUCKET_COUNT = 8;
const MAX_BATCH_KEYS = 200;
const BATCH_SIZE_BUCKETS = [
  ...exponentialBuckets(BATCH_BUCKET_START, BATCH_BUCKET_FACTOR, BATCH_BUCKET_COUNT),
  MAX_BATCH_KEYS,
];

/** GraphQL metrics (API-009), on the app's registry. */
export interface GraphqlMetrics {
  /** `graphql_requests_total{operation}`: operations that reached validation (`anonymous` when unnamed). */
  readonly requests: Counter<'operation'>;
  /** `graphql_complexity`: estimated cost of each analysed operation. */
  readonly complexity: Histogram;
  /** `graphql_rejected_total{reason}`: operations refused by a query limit (`depth`, `complexity`, `aliases`). */
  readonly rejected: Counter<'reason'>;
  /** `graphql_persisted_hits_total`: requests whose persisted-query id resolved to a manifest entry. */
  readonly persistedHits: Counter;
  /** `graphql_persisted_misses_total`: requests whose persisted-query id is in no loaded manifest. */
  readonly persistedMisses: Counter;
  /** `graphql_persisted_rejected_total{reason}`: requests refused by the persisted-query gate (API-GQL-PERSIST). */
  readonly persistedRejected: Counter<'reason'>;
  /** `graph_gql_resolver_ms{field}`: time one surface resolver spent answering, by root field. */
  readonly resolverMs: Histogram<'field'>;
  /** `graphql_dataloader_batch_size`: keys each surface DataLoader batch carried. */
  readonly dataloaderBatchSize: Histogram;
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
    persistedHits: new Counter({
      name: 'graphql_persisted_hits_total',
      help: 'GraphQL requests whose persisted-query id resolved to a manifest entry.',
      registers: [registry],
    }),
    persistedMisses: new Counter({
      name: 'graphql_persisted_misses_total',
      help: 'GraphQL requests whose persisted-query id is in no loaded manifest.',
      registers: [registry],
    }),
    persistedRejected: new Counter({
      name: 'graphql_persisted_rejected_total',
      help: 'GraphQL requests refused by the persisted-query gate, by reason.',
      labelNames: ['reason'],
      registers: [registry],
    }),
    resolverMs: new Histogram({
      name: 'graph_gql_resolver_ms',
      help: 'Time a surface GraphQL resolver spent answering, in milliseconds, by root field.',
      labelNames: ['field'],
      buckets: RESOLVER_MS_BUCKETS,
      registers: [registry],
    }),
    dataloaderBatchSize: new Histogram({
      name: 'graphql_dataloader_batch_size',
      help: 'Keys each GraphQL DataLoader batch carried.',
      buckets: BATCH_SIZE_BUCKETS,
      registers: [registry],
    }),
  };
}
