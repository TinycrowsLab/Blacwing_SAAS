import { describe, expect, it } from 'vitest';

import { generateVirtualKey, hashVirtualKey } from '@blackwing/crypto';

import { authenticateVirtualKey, evaluateVirtualKey, type VirtualKeyRecord } from './index.js';

const NOW = new Date('2026-10-31T10:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);

function record(overrides: Partial<VirtualKeyRecord> = {}): VirtualKeyRecord {
  return {
    id: '0196f0a0-0000-7000-8000-000000000001',
    tenantId: '0196f0a0-0000-7000-8000-0000000000aa',
    runId: '0196f0a0-0000-7000-8000-0000000000bb',
    sessionId: '0196f0a0-0000-7000-8000-0000000000cc',
    persona: 'planner',
    budgetContext: { costCapUsd: 5 },
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    revokedAt: null,
    ...overrides,
  };
}

describe('evaluateVirtualKey', () => {
  it('yields the request context of a live key', () => {
    expect(evaluateVirtualKey(record(), NOW)).toMatchObject({
      virtualKeyId: record().id,
      tenantId: record().tenantId,
      runId: record().runId,
      sessionId: record().sessionId,
      persona: 'planner',
      budgetContext: { costCapUsd: 5 },
    });
  });

  it('refuses a revoked key, whatever its expiry', () => {
    expect(evaluateVirtualKey(record({ revokedAt: NOW }), NOW)).toBeUndefined();
  });

  it('refuses a key at and after its expiry: no clock leeway', () => {
    expect(evaluateVirtualKey(record({ expiresAt: NOW }), NOW)).toBeUndefined();
    expect(evaluateVirtualKey(record({ expiresAt: NOW }), LATER)).toBeUndefined();
    expect(
      evaluateVirtualKey(record({ expiresAt: new Date(NOW.getTime() + 1) }), NOW),
    ).toBeDefined();
  });

  it('refuses unreadable budget context (fail closed)', () => {
    expect(evaluateVirtualKey(record({ budgetContext: { costCapUsd: -1 } }), NOW)).toBeUndefined();
    expect(evaluateVirtualKey(record({ budgetContext: { unknown: 1 } }), NOW)).toBeUndefined();
  });
});

describe('authenticateVirtualKey', () => {
  it('resolves a presented key by its hash and accepts it while live', async () => {
    const key = generateVirtualKey();
    const seen: Buffer[] = [];
    const result = await authenticateVirtualKey(
      key,
      (hash) => {
        seen.push(hash);
        return Promise.resolve(record());
      },
      NOW,
    );
    expect(seen[0]?.equals(hashVirtualKey(key))).toBe(true);
    expect(result?.virtualKeyId).toBe(record().id);
  });

  it('never looks up a malformed credential', async () => {
    let calls = 0;
    const resolve = () => {
      calls += 1;
      return Promise.resolve(record());
    };
    for (const bad of ['', 'bwk_short', 'sk-ant-123', `bwk_${'!'.repeat(43)}`, ' bwk_x']) {
      expect(await authenticateVirtualKey(bad, resolve, NOW)).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it('answers undefined for an unknown key, the same as any other refusal', async () => {
    expect(
      await authenticateVirtualKey(generateVirtualKey(), () => Promise.resolve(null), NOW),
    ).toBeUndefined();
  });

  it('propagates a resolver failure instead of accepting the key', async () => {
    await expect(
      authenticateVirtualKey(generateVirtualKey(), () => Promise.reject(new Error('db down')), NOW),
    ).rejects.toThrow('db down');
  });
});
