import { Worker, type ConnectionOptions } from 'bullmq';

import { ingestUsageEvent, type CostIngestDeps } from './ingest.js';

/** BullMQ queue the model gateway's usage events are published to, one job per event. */
export const COST_USAGE_QUEUE = 'cost-usage';

/** Jobs processed in parallel. Ingestion is idempotent per event, so retries and overlap are safe. */
const CONCURRENCY = 4;

/**
 * Consumes `cost-usage` jobs on Valkey and ingests each event (at-least-once delivery; the ledger's unique
 * `(tenant_id, usage_event_id)` key makes the effect exactly-once). A failed job is retried by BullMQ and,
 * when malformed, stays in the failed set for an operator.
 */
export function startCostUsageWorker(connection: ConnectionOptions, deps: CostIngestDeps): Worker {
  return new Worker(
    COST_USAGE_QUEUE,
    async (job) => {
      await ingestUsageEvent(deps, job.data);
    },
    { connection, concurrency: CONCURRENCY },
  );
}
