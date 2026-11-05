// DEMO-STORY audit ledger tests: the hash covers every field and the chain check finds the first tampered row.
import { describe, expect, it } from 'vitest';

import { GENESIS, auditHash, verifyChain, type AuditFields } from './audit.js';

function chain(length: number) {
  const rows: (AuditFields & { prevHash: string; hash: string })[] = [];
  let prevHash = GENESIS;
  for (let seq = 1; seq <= length; seq += 1) {
    const fields: AuditFields = {
      seq,
      at: new Date(Date.UTC(2026, 10, 5, 10, 0, seq)),
      actorId: 'u1',
      actorName: 'Owner',
      action: 'gate2.approve',
      targetType: 'gate2',
      targetId: `0197a5d0-aaaa-7000-8000-00000000000${seq}`,
      payload: { reason: 'looks safe', decision: 'approve' },
    };
    const hash = auditHash(prevHash, fields);
    rows.push({ ...fields, prevHash, hash });
    prevHash = hash;
  }
  return rows;
}

describe('auditHash', () => {
  it('is 64 hex characters and ignores payload key order', () => {
    const [row] = chain(1);
    if (row === undefined) throw new Error('no row');
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(auditHash(GENESIS, { ...row, payload: { decision: 'approve', reason: 'looks safe' } })).toBe(row.hash);
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain and an empty ledger', () => {
    expect(verifyChain(chain(3))).toEqual({ verified: true, count: 3, brokenAtSeq: null });
    expect(verifyChain([])).toEqual({ verified: true, count: 0, brokenAtSeq: null });
  });

  it('reports the first row whose content was changed', () => {
    const rows = chain(4);
    const second = rows[1];
    if (second === undefined) throw new Error('no row');
    rows[1] = { ...second, payload: { reason: 'edited', decision: 'approve' } };
    expect(verifyChain(rows)).toEqual({ verified: false, count: 4, brokenAtSeq: 2 });
  });

  it('reports a deleted row as a gap', () => {
    const rows = chain(4);
    rows.splice(1, 1);
    expect(verifyChain(rows)).toMatchObject({ verified: false, brokenAtSeq: 3 });
  });
});
