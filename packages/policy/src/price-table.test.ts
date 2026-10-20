import { describe, expect, it } from 'vitest';

import {
  CURRENT_PRICE_TABLE_VERSION,
  PRICE_TABLE_2026_10_01,
  PriceTableError,
  computeCost,
  currentVersion,
  getPriceTable,
  priceTableDigest,
  priceTablePin,
  resolvePinnedTable,
  type PriceTable,
  type PriceTableResolver,
} from './price-table.js';

// Recorded digest of released version 2026-10-01. If this fails, you edited a released table:
// cut a NEW version instead of changing this one.
const RELEASED_DIGESTS: Record<string, string> = {
  '2026-10-01': '7f0d5295cf6c90a0f9862eb746732ec7229d66146b0c9d4728f4714bbd9fd667',
};

describe('price table', () => {
  it('released content is immutable (digest matches recorded value)', () => {
    expect(priceTableDigest(PRICE_TABLE_2026_10_01)).toBe(RELEASED_DIGESTS['2026-10-01']);
    for (const v of Object.keys(RELEASED_DIGESTS)) {
      expect(priceTableDigest(getPriceTable(v))).toBe(RELEASED_DIGESTS[v]);
    }
    expect(RELEASED_DIGESTS[CURRENT_PRICE_TABLE_VERSION]).toBeDefined();
  });

  it('digest changes when any price changes', () => {
    const t = getPriceTable(currentVersion());
    const model = 'anthropic/claude-sonnet-5-5';
    const base = t.entries[model];
    if (!base) throw new Error('fixture model missing');
    const mutated: PriceTable = {
      ...t,
      entries: { ...t.entries, [model]: { ...base, input: base.input + 1 } },
    };
    expect(priceTableDigest(mutated)).not.toBe(priceTableDigest(t));
  });

  it('table is frozen', () => {
    const t = getPriceTable(currentVersion());
    expect(() => {
      (t.entries as Record<string, unknown>)['x/y'] = {};
    }).toThrow();
  });

  it('pin carries version and hash for the snapshot', () => {
    const pin = priceTablePin();
    expect(pin.priceTableVersion).toBe(currentVersion());
    expect(pin.priceTableSha256).toBe(RELEASED_DIGESTS[currentVersion()]);
    expect(pin.priceTableSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prices a known model', () => {
    const r = computeCost(priceTablePin(), 'anthropic/claude-sonnet-5-5', {
      input: 1_000_000,
      output: 500_000,
      cacheRead: 2_000_000,
      cacheWrite: 1_000_000,
    });
    expect(r).toMatchObject({
      ok: true,
      costMicroUsd: 3_000_000 + 7_500_000 + 600_000 + 3_750_000,
    });
  });

  it('unknown model denies (not zero) and fires the deny hook', () => {
    const seen: string[] = [];
    const r = computeCost(
      priceTablePin(),
      'anthropic/nope',
      { input: 1 },
      { onDeny: (reason) => seen.push(reason) },
    );
    expect(r).toMatchObject({ ok: false, reason: 'unknown_model' });
    expect(seen).toEqual(['unknown_model']);
  });

  it('prototype-key model names do not resolve', () => {
    expect(computeCost(priceTablePin(), 'constructor', { input: 1 })).toMatchObject({ ok: false });
    expect(computeCost(priceTablePin(), '__proto__', { input: 1 })).toMatchObject({ ok: false });
  });

  it('missing version at replay fails closed', () => {
    const r = computeCost(
      { priceTableVersion: '1999-01-01', priceTableSha256: 'x' },
      'anthropic/claude-sonnet-5-5',
      {},
    );
    expect(r).toMatchObject({ ok: false, reason: 'unknown_price_table_version' });
    expect(() => getPriceTable('1999-01-01')).toThrow(PriceTableError);
  });

  it('pinned hash mismatch fails closed', () => {
    const pin = { ...priceTablePin(), priceTableSha256: '0'.repeat(64) };
    expect(computeCost(pin, 'anthropic/claude-sonnet-5-5', {})).toMatchObject({
      ok: false,
      reason: 'hash_mismatch',
    });
  });

  it('a run keeps its pinned version when a newer one exists', () => {
    const old = getPriceTable(currentVersion());
    const newer: PriceTable = { ...old, version: '2099-01-01', entries: {} };
    const pin = priceTablePin();
    const resolver: PriceTableResolver = {
      currentVersion: () => newer.version,
      getPriceTable: (v) => (v === newer.version ? newer : old),
    };
    expect(resolvePinnedTable(pin, resolver)).toBe(old);
    expect(
      computeCost(pin, 'anthropic/claude-sonnet-5-5', { input: 1 }, { resolver }),
    ).toMatchObject({ ok: true });
  });

  it('micro-costs round up and never to zero for non-zero usage', () => {
    const r = computeCost(priceTablePin(), 'anthropic/claude-haiku-5-5', { cacheRead: 1 });
    expect(r).toMatchObject({ ok: true, costMicroUsd: 1 });
    expect(computeCost(priceTablePin(), 'anthropic/claude-haiku-5-5', {})).toMatchObject({
      costMicroUsd: 0,
    });
  });

  it('handles huge token counts exactly and rejects invalid counts', () => {
    const r = computeCost(priceTablePin(), 'anthropic/claude-opus-4-1', { output: 1_000_000_000 });
    expect(r).toMatchObject({ ok: true, costMicroUsd: 75_000_000_000 });
    expect(() => computeCost(priceTablePin(), 'anthropic/claude-opus-4-1', { input: -1 })).toThrow(
      RangeError,
    );
  });
});
