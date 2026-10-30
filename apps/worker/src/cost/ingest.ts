import { trace } from '@opentelemetry/api';

import { costUsageEventSchema, type CostUsageEvent } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { buildLedgerRow, stageForRunState, type UnpricedReason } from './attribution.js';

import type { CostIngestMetrics, CostIngestStore, CostPriceRow } from './ports.js';
import type { Logger } from '@blackwing/logger';

const tracer = trace.getTracer('@blackwing/worker');

export interface CostIngestDeps {
  readonly store: CostIngestStore;
  readonly metrics: CostIngestMetrics;
  readonly logger: Logger;
  /** Epoch milliseconds; injected so the lag metric is testable. */
  readonly now?: () => number;
}

export interface IngestOutcome {
  /** `recorded`: a new ledger row. `duplicate`: the event had been recorded before (a no-op). */
  readonly status: 'recorded' | 'duplicate';
  /** Why the row was written unpriced, or `null` when it was priced. */
  readonly unpriced: UnpricedReason | null;
}

/**
 * Ingests one gateway usage event into `cost_ledger` (COST-002). The event is parsed at the boundary:
 * unknown fields, content included, are stripped and never reach the ledger (CONTEXT_PACK §8.7). A
 * malformed event is refused with a generic message (no echoed values). An unpriceable event is recorded at
 * zero cost, flagged and alerted; it is never dropped. Replays are no-ops (idempotent on the usage event id).
 */
export async function ingestUsageEvent(deps: CostIngestDeps, raw: unknown): Promise<IngestOutcome> {
  const parsed = costUsageEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('usage event is malformed');
  }
  const event: CostUsageEvent = parsed.data;
  return tracer.startActiveSpan('cost.ingest', async (span) => {
    try {
      return await record(deps, event);
    } finally {
      span.end();
    }
  });
}

async function record(deps: CostIngestDeps, event: CostUsageEvent): Promise<IngestOutcome> {
  const { store, metrics, logger } = deps;
  const tenantId = event.tenantId;
  const run = event.runId === null ? undefined : await store.findRun(tenantId, event.runId);
  const pricing = await priceFor(
    store,
    tenantId,
    event,
    run?.priceTableVersion ?? null,
    run !== undefined,
  );

  const { row, unpriced } = buildLedgerRow(
    {
      runId: run === undefined ? null : event.runId,
      stage: stageForRunState(run?.state),
      persona: event.persona,
      agentSessionId: event.sessionId,
      provider: event.provider,
      model: event.model,
      usageEventId: event.usageEventId,
      occurredAt: event.occurredAt,
      tokens: {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheReadTokens: event.cacheReadTokens,
      },
    },
    pricing,
  );

  const inserted = await store.insertLedgerRow(tenantId, row);
  metrics.lagMs(Math.max(0, (deps.now ?? Date.now)() - Date.parse(event.occurredAt)));
  if (!inserted) {
    metrics.event('duplicate');
    return { status: 'duplicate', unpriced: null };
  }
  if (unpriced !== null) {
    metrics.event('unpriced');
    metrics.unpriced(unpriced);
    logger.error(
      {
        alert: 'cost_ingest_unpriced',
        tenantId,
        runId: row.runId,
        usageEventId: event.usageEventId,
        model: event.model,
        reason: unpriced,
      },
      'usage recorded at zero cost: no price for it at the run pin',
    );
    return { status: 'recorded', unpriced };
  }
  metrics.event('recorded');
  return { status: 'recorded', unpriced: null };
}

type Pricing =
  | { readonly ok: true; readonly price: CostPriceRow }
  | { readonly ok: false; readonly reason: UnpricedReason };

/** The run's pinned table is the only one that prices usage (§8.9); no pin or no price row means unpriced. */
async function priceFor(
  store: CostIngestStore,
  tenantId: string,
  event: CostUsageEvent,
  pin: number | null,
  hasRun: boolean,
): Promise<Pricing> {
  if (!hasRun || pin === null) return { ok: false, reason: 'run_unpinned' };
  const price = await store.findPrice(tenantId, {
    provider: event.provider,
    model: event.model,
    version: pin,
  });
  return price === undefined ? { ok: false, reason: 'unknown_model' } : { ok: true, price };
}
