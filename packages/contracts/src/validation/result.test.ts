import { describe, expect, it } from 'vitest';

import { MAX_VALIDATION_ATTEMPTS, validationResultSchema } from './result.js';

const CANDIDATE_ID = '018f3b2a-7c1d-7a00-8000-000000000003';

/** A valid confirmed result. Each test edits a copy. */
function confirmed(): Record<string, unknown> {
  return {
    candidateId: CANDIDATE_ID,
    outcome: 'confirmed',
    oracleType: 'status_diff',
    positiveFired: true,
    negativeControlClean: true,
    reason: 'status changed from 403 to 200 with the authorised object id',
    evidenceRefs: ['runs/0190/evidence-1.har'],
    replayMs: 1500,
    attempts: 3,
    flaky: false,
  };
}

describe('validationResultSchema', () => {
  it('parses a confirmed result whose oracle fired and whose negative control stayed clean', () => {
    expect(validationResultSchema.safeParse(confirmed()).success).toBe(true);
  });

  it('rejects confirmed when the negative control fired', () => {
    const result = validationResultSchema.safeParse({
      ...confirmed(),
      negativeControlClean: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects confirmed when the positive oracle did not fire', () => {
    const result = validationResultSchema.safeParse({ ...confirmed(), positiveFired: false });
    expect(result.success).toBe(false);
  });

  it('rejects confirmed with no evidence reference', () => {
    const result = validationResultSchema.safeParse({ ...confirmed(), evidenceRefs: [] });
    expect(result.success).toBe(false);
  });

  it('accepts a suspected result that did not prove the oracle, with its reason', () => {
    const result = validationResultSchema.safeParse({
      ...confirmed(),
      outcome: 'suspected',
      positiveFired: false,
      negativeControlClean: false,
      evidenceRefs: [],
      reason: 'negative control fired; the response is not specific to the oracle',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown oracle type', () => {
    expect(validationResultSchema.safeParse({ ...confirmed(), oracleType: 'eval' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown outcome', () => {
    expect(validationResultSchema.safeParse({ ...confirmed(), outcome: 'released' }).success).toBe(
      false,
    );
  });

  it('bounds attempts and replay time', () => {
    expect(validationResultSchema.safeParse({ ...confirmed(), attempts: 0 }).success).toBe(false);
    expect(
      validationResultSchema.safeParse({ ...confirmed(), attempts: MAX_VALIDATION_ATTEMPTS + 1 })
        .success,
    ).toBe(false);
    expect(validationResultSchema.safeParse({ ...confirmed(), replayMs: -1 }).success).toBe(false);
  });

  it('rejects a reason that carries control characters', () => {
    const result = validationResultSchema.safeParse({
      ...confirmed(),
      reason: 'ok\u0007',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra keys', () => {
    expect(validationResultSchema.safeParse({ ...confirmed(), payload: 'GET /' }).success).toBe(
      false,
    );
  });
});
