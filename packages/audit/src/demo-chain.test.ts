// DEMO-STORY ledger chain: a fixed vector pins the hash input byte for byte (existing rows must keep verifying).
import { describe, expect, it } from 'vitest';

import { DEMO_GENESIS, demoAuditHash, type DemoAuditFields, verifyDemoChain } from './index.js';

const FIXED: DemoAuditFields = {
  seq: 1,
  at: new Date('2026-11-08T12:00:00.000Z'),
  actorId: null,
  actorName: 'Blackwing',
  action: 'gate2.expired',
  targetType: 'gate2',
  targetId: '0197a5d0-aaaa-7000-8000-000000000001',
  payload: {
    runId: 'r1',
    method: 'POST',
    url: 'http://127.0.0.1:3001/api/Users',
    deadlineAt: '2026-11-08T12:05:00.000Z',
  },
};
const FIXED_HASH = '88fe19a2bc9426919521e02a62be8795679a9ad6cb3930f78f1d5338b06d17c9';

describe('demo ledger chain', () => {
  it('hashes the fixed vector to the fixed value', () => {
    expect(DEMO_GENESIS).toBe('0'.repeat(64));
    expect(demoAuditHash(DEMO_GENESIS, FIXED)).toBe(FIXED_HASH);
  });

  it('verifies a chain and names the first tampered row', () => {
    const second = { ...FIXED, seq: 2, payload: { runId: 'r2' } };
    const hash2 = demoAuditHash(FIXED_HASH, second);
    const rows = [
      { ...FIXED, prevHash: DEMO_GENESIS, hash: FIXED_HASH },
      { ...second, prevHash: FIXED_HASH, hash: hash2 },
    ];
    expect(verifyDemoChain(rows)).toEqual({ verified: true, count: 2, brokenAtSeq: null });
    const tampered = [rows[0], { ...second, payload: { runId: 'r3' }, prevHash: FIXED_HASH, hash: hash2 }];
    expect(verifyDemoChain(tampered.filter((r) => r !== undefined))).toEqual({
      verified: false,
      count: 2,
      brokenAtSeq: 2,
    });
  });
});
