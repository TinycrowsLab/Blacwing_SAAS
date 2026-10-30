import { describe, expect, it } from 'vitest';

import { RUN_STATES } from '@blackwing/contracts';

import { buildLedgerRow, priceMicros, priceUsage, stageForRunState } from './attribution.js';

const PRICE = {
  id: '0190a000-0000-7000-8000-000000000e01',
  inputPerMtok: '3.000000',
  outputPerMtok: '15.000000',
  cacheWritePerMtok: '3.750000',
  cacheReadPerMtok: '0.300000',
};
const NO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
const USAGE = {
  runId: '0190a000-0000-7000-8000-000000000a01',
  stage: 'execution' as const,
  persona: 'recon-scout',
  agentSessionId: null,
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5-5',
  usageEventId: 'evt_1',
  occurredAt: '2026-10-20T10:00:00.000Z',
  tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
};

describe('stageForRunState', () => {
  it('maps each run phase to a cost stage', () => {
    expect(stageForRunState('recon')).toBe('recon');
    expect(stageForRunState('planning')).toBe('planning');
    expect(stageForRunState('executing')).toBe('execution');
    expect(stageForRunState('validating')).toBe('validation');
    expect(stageForRunState('reporting')).toBe('reporting');
  });

  it('maps every run state to a stage, defaulting to other for states outside a phase', () => {
    for (const state of RUN_STATES) {
      expect(['recon', 'planning', 'execution', 'validation', 'reporting', 'other']).toContain(
        stageForRunState(state),
      );
    }
    expect(stageForRunState('draft')).toBe('other');
    expect(stageForRunState('cancelled')).toBe('other');
  });

  it('falls back to other when the run is unknown', () => {
    expect(stageForRunState(undefined)).toBe('other');
  });
});

describe('priceMicros', () => {
  it('parses a price string into exact integer micro-units', () => {
    expect(priceMicros('3.000000')).toBe(3_000_000n);
    expect(priceMicros('0.100000')).toBe(100_000n);
    expect(priceMicros('0.000001')).toBe(1n);
    expect(priceMicros('25')).toBe(25_000_000n);
  });
});

describe('priceUsage', () => {
  it('costs one million input tokens at the input rate, exactly', () => {
    expect(priceUsage(PRICE, { ...NO_TOKENS, inputTokens: 1_000_000 })).toBe('3.0000000000');
  });

  it('sums the four components', () => {
    const cost = priceUsage(PRICE, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBe('22.0500000000');
  });

  it('rounds each component up to the next 1e-10 USD (never under-reports)', () => {
    // One token at $0.000001 per Mtok is 1e-12 USD: booked as the smallest representable unit.
    const tiny = { ...PRICE, inputPerMtok: '0.000001' };
    expect(priceUsage(tiny, { ...NO_TOKENS, inputTokens: 1 })).toBe('0.0000000001');
  });

  it('costs zero tokens at zero', () => {
    expect(priceUsage(PRICE, NO_TOKENS)).toBe('0.0000000000');
  });

  it('returns a decimal string that fits the ledger numeric', () => {
    expect(priceUsage(PRICE, { ...NO_TOKENS, outputTokens: 1_000_000_000 })).toMatch(
      /^\d{1,8}\.\d{10}$/u,
    );
  });
});

describe('buildLedgerRow', () => {
  it('pins a priced row to the price table and costs it', () => {
    const { row, unpriced } = buildLedgerRow(USAGE, { ok: true, price: PRICE });
    expect(unpriced).toBeNull();
    expect(row).toMatchObject({
      runId: USAGE.runId,
      stage: 'execution',
      persona: 'recon-scout',
      priceTableId: PRICE.id,
      needsPricing: false,
      costUsd: '3.0000000000',
    });
  });

  it('keeps an unpriced row with no table, zero cost and the reason, and never drops its counts', () => {
    const { row, unpriced } = buildLedgerRow(USAGE, { ok: false, reason: 'unknown_model' });
    expect(unpriced).toBe('unknown_model');
    expect(row).toMatchObject({
      priceTableId: null,
      needsPricing: true,
      costUsd: '0',
      inputTokens: 1_000_000,
    });
  });
});
