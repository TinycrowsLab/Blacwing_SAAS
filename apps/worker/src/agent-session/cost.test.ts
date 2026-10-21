import { describe, expect, it } from 'vitest';

import { costEntries, UNATTRIBUTED_MODEL } from './cost.js';
import { RUN_OK } from './testing.js';

const USAGE = RUN_OK.result.modelUsage['claude-sonnet-5-5'] ?? {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0,
};
const REC = { tenantId: 't', runId: 'r', sessionRef: 's', persona: 'p' };

describe('costEntries', () => {
  it('books one row per model from modelUsage', () => {
    const result = {
      ...RUN_OK.result,
      modelUsage: {
        a: { ...USAGE, costUSD: 0.1 },
        b: { ...USAGE, costUSD: 0.3 },
      },
    };
    const rows = costEntries(REC, result);
    expect(rows.map((r) => [r.model, r.usage.costUSD])).toEqual([
      ['a', 0.1],
      ['b', 0.3],
    ]);
    expect(rows[0]).toMatchObject(REC);
  });

  it('falls back to the session total when modelUsage is empty', () => {
    const rows = costEntries(REC, { ...RUN_OK.result, modelUsage: {}, total_cost_usd: 0.9 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: UNATTRIBUTED_MODEL });
    expect(rows[0]?.usage.costUSD).toBe(0.9);
  });

  it('books nothing for a zero-cost session without usage', () => {
    expect(costEntries(REC, { ...RUN_OK.result, modelUsage: {}, total_cost_usd: 0 })).toEqual([]);
  });
});
