import { describe, expect, it } from 'vitest';

import {
  COST_TOKENS_MAX,
  costLedgerEntrySchema,
  costModelIdSchema,
  costPriceSchema,
  costUsdSchema,
  priceTableSchema,
} from '../index.js';

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
const AT = '2026-10-20T10:00:00.000Z';
const SHA = 'a'.repeat(64);

const entry = (overrides: Record<string, unknown> = {}) => ({
  runId: UUID,
  subtaskId: null,
  agentSessionId: null,
  stage: 'execution',
  persona: null,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  priceTableId: UUID,
  inputTokens: 1200,
  outputTokens: 300,
  cacheWriteTokens: 0,
  cacheReadTokens: 50,
  costUsd: '0.0123456789',
  usageEventId: 'evt_01',
  occurredAt: AT,
  ...overrides,
});

describe('costModelIdSchema', () => {
  it.each(['claude-opus-5-5', 'claude-haiku-5-5', 'gpt-oss-120b'])('accepts %s', (id) => {
    expect(costModelIdSchema.safeParse(id).success).toBe(true);
  });

  it.each([
    ['a dated alias', 'claude-sonnet-5-5-20261001'],
    ['an upper-case id', 'Claude-Sonnet-5-5'],
    ['an empty id', ''],
    ['a path-like id', 'anthropic/claude-sonnet-5-5'],
    ['whitespace', 'claude sonnet'],
  ])('refuses %s', (_label, id) => {
    expect(costModelIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('money decimal strings', () => {
  it.each(['0', '1', '3.5', '0.000001', '99999999.999999'])('price accepts %s', (value) => {
    expect(costPriceSchema.safeParse(value).success).toBe(true);
  });

  it.each(['-1', '1.0000001', '1e3', '100000000', '', 'NaN', '1,5', 0.5])(
    'price refuses %s (floats and negatives never reach the numeric column)',
    (value) => {
      expect(costPriceSchema.safeParse(value).success).toBe(false);
    },
  );

  it('cost accepts ten decimal places and refuses an eleventh', () => {
    expect(costUsdSchema.safeParse('0.0000000001').success).toBe(true);
    expect(costUsdSchema.safeParse('0.00000000001').success).toBe(false);
  });
});

describe('costLedgerEntrySchema', () => {
  it('accepts a well-formed usage row with nullable subtask, session and persona', () => {
    expect(costLedgerEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it('refuses negative token counts, fractional counts and counts above the cap', () => {
    for (const field of ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']) {
      expect(costLedgerEntrySchema.safeParse(entry({ [field]: -1 })).success, field).toBe(false);
      expect(costLedgerEntrySchema.safeParse(entry({ [field]: 1.5 })).success, field).toBe(false);
      expect(
        costLedgerEntrySchema.safeParse(entry({ [field]: COST_TOKENS_MAX + 1 })).success,
        field,
      ).toBe(false);
    }
  });

  it('refuses an unknown stage and an unknown provider', () => {
    expect(costLedgerEntrySchema.safeParse(entry({ stage: 'exfiltration' })).success).toBe(false);
    expect(costLedgerEntrySchema.safeParse(entry({ provider: 'openai' })).success).toBe(false);
  });

  it('refuses a dated model id on the ledger row', () => {
    expect(
      costLedgerEntrySchema.safeParse(entry({ model: 'claude-sonnet-5-5-20261001' })).success,
    ).toBe(false);
  });

  it('refuses a missing usage event id (the idempotency key)', () => {
    expect(costLedgerEntrySchema.safeParse(entry({ usageEventId: '' })).success).toBe(false);
  });

  it('refuses a missing price table pin', () => {
    expect(costLedgerEntrySchema.safeParse({ ...entry(), priceTableId: undefined }).success).toBe(
      false,
    );
  });
});

describe('priceTableSchema', () => {
  const table = {
    id: UUID,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    version: 1,
    inputPerMtok: '5',
    outputPerMtok: '25',
    cacheWritePerMtok: '6.25',
    cacheReadPerMtok: '0.5',
    currency: 'USD',
    effectiveFrom: AT,
    sha256: SHA,
    active: true,
    createdAt: AT,
    updatedAt: AT,
  };

  it('accepts a versioned USD table', () => {
    expect(priceTableSchema.safeParse(table).success).toBe(true);
  });

  it('refuses a non-USD currency, a version below 1 and a malformed digest', () => {
    expect(priceTableSchema.safeParse({ ...table, currency: 'EUR' }).success).toBe(false);
    expect(priceTableSchema.safeParse({ ...table, version: 0 }).success).toBe(false);
    expect(priceTableSchema.safeParse({ ...table, sha256: 'ABC' }).success).toBe(false);
  });
});
