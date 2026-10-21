import type { CostLedgerEntry } from './ports.js';
import type { CostRecord, SessionResultMessage } from './types.js';

/** Model key used when only the session total is known. */
export const UNATTRIBUTED_MODEL = 'unattributed';

/**
 * Ledger rows for one session. `modelUsage` is preferred (one row per model); when the SDK reported
 * none but a non-zero total, the total is booked once rather than lost.
 */
export function costEntries(
  record: CostRecord,
  result: SessionResultMessage,
): readonly CostLedgerEntry[] {
  const models = Object.entries(result.modelUsage);
  if (models.length > 0) {
    return models.map(([model, usage]) => ({ ...record, model, usage }));
  }
  if (result.total_cost_usd > 0) {
    return [
      {
        ...record,
        model: UNATTRIBUTED_MODEL,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: result.total_cost_usd,
        },
      },
    ];
  }
  return [];
}
