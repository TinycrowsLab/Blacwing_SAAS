import { describe, expect, it } from 'vitest';

import { acceptedRiskValid, classifyVerdict, dedupeDecisions } from './classify.js';
import { CONFIRMED_VERDICT } from './testing.js';

describe('classifyVerdict', () => {
  it('confirms only an oracle pass, a silent negative control and both artifacts', () => {
    expect(classifyVerdict('f1', CONFIRMED_VERDICT)).toEqual({
      findingId: 'f1',
      outcome: 'confirmed',
      evidenceBundleId: 'evb-1',
      reproArtifactId: 'repro-1',
    });
  });

  it('routes a failed oracle to suspected', () => {
    expect(classifyVerdict('f', { ...CONFIRMED_VERDICT, oraclePassed: false })).toMatchObject({
      outcome: 'suspected',
      reason: 'ORACLE_FAILED',
    });
  });

  it('treats a confirmed verdict whose negative control also fired as suspected', () => {
    expect(
      classifyVerdict('f', { ...CONFIRMED_VERDICT, negativeControlFired: true }),
    ).toMatchObject({ outcome: 'suspected', reason: 'NEGATIVE_CONTROL_FIRED' });
  });

  it.each([{ evidenceBundleId: null }, { reproArtifactId: null }])(
    'treats missing evidence %j as suspected (F18)',
    (over) => {
      expect(classifyVerdict('f', { ...CONFIRMED_VERDICT, ...over })).toMatchObject({
        outcome: 'suspected',
        reason: 'EVIDENCE_MISSING',
      });
    },
  );
});

describe('acceptedRiskValid', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const base = { findingId: 'f', decision: 'accepted_risk' } as const;

  it('needs a reason and a future expiry', () => {
    expect(
      acceptedRiskValid({ ...base, reason: 'r', expiresAt: '2026-06-01T00:00:00.000Z' }, now),
    ).toBe(true);
    expect(acceptedRiskValid({ ...base, expiresAt: '2026-06-01T00:00:00.000Z' }, now)).toBe(false);
    expect(
      acceptedRiskValid({ ...base, reason: '   ', expiresAt: '2026-06-01T00:00:00.000Z' }, now),
    ).toBe(false);
    expect(acceptedRiskValid({ ...base, reason: 'r' }, now)).toBe(false);
  });

  it('refuses a past, equal or unparsable expiry', () => {
    expect(
      acceptedRiskValid({ ...base, reason: 'r', expiresAt: '2025-12-31T00:00:00.000Z' }, now),
    ).toBe(false);
    expect(acceptedRiskValid({ ...base, reason: 'r', expiresAt: now.toISOString() }, now)).toBe(
      false,
    );
    expect(acceptedRiskValid({ ...base, reason: 'r', expiresAt: 'soon' }, now)).toBe(false);
  });
});

describe('dedupeDecisions', () => {
  it('collapses an identical repeat and flags a conflicting one', () => {
    const r = dedupeDecisions([
      { findingId: 'a', decision: 'released' },
      { findingId: 'a', decision: 'released' },
      { findingId: 'b', decision: 'duplicate' },
      { findingId: 'b', decision: 'released' },
    ]);
    expect(r.unique.map((d) => d.findingId)).toEqual(['a', 'b']);
    expect(r.conflicts).toEqual([{ findingId: 'b', code: 'DECISION_CONFLICT' }]);
  });
});
