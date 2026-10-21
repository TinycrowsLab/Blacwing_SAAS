import { Counter, type Registry } from 'prom-client';

/** Idempotency-Key metrics (API-008 observability), on the app's registry. */
export interface IdempotencyMetrics {
  /** `idempotency_hits_total{route}`: stored responses replayed. */
  readonly hits: Counter<'route'>;
  /** `idempotency_conflicts_total{route}`: a key reused with a different request (409). */
  readonly conflicts: Counter<'route'>;
  /** `idempotency_inflight_total{route}`: duplicates refused while the first request ran (409). */
  readonly inflight: Counter<'route'>;
  /** `idempotency_store_errors_total{operation}`: Valkey failures, by operation (`acquire`, `complete`, `release`). */
  readonly storeErrors: Counter<'operation'>;
}

export function createIdempotencyMetrics(registry: Registry): IdempotencyMetrics {
  return {
    hits: new Counter({
      name: 'idempotency_hits_total',
      help: 'Requests answered by replaying the stored response of an earlier Idempotency-Key, by route template.',
      labelNames: ['route'],
      registers: [registry],
    }),
    conflicts: new Counter({
      name: 'idempotency_conflicts_total',
      help: 'Requests refused because their Idempotency-Key was first used with a different request, by route template.',
      labelNames: ['route'],
      registers: [registry],
    }),
    inflight: new Counter({
      name: 'idempotency_inflight_total',
      help: 'Duplicate requests refused while the first request with the same Idempotency-Key was still running, by route template.',
      labelNames: ['route'],
      registers: [registry],
    }),
    storeErrors: new Counter({
      name: 'idempotency_store_errors_total',
      help: 'Idempotency store (Valkey) operations that failed, by operation.',
      labelNames: ['operation'],
      registers: [registry],
    }),
  };
}
