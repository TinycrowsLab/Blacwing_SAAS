import { describe, expect, it } from 'vitest';

import { bodyDigest, evaluateErrorSignature, type ErrorSignatureOracle } from './oracle.js';

const oracle: ErrorSignatureOracle = {
  id: 'oracle.test.error_signature.v1',
  type: 'error_signature',
  expectedStatus: 500,
  signatures: ['SQLITE_ERROR', 'SequelizeDatabaseError'],
};

describe('evaluateErrorSignature', () => {
  it('matches a 500 whose body carries a declared signature and names it', () => {
    expect(
      evaluateErrorSignature(oracle, { status: 500, body: '<title>SQLITE_ERROR: near</title>' }),
    ).toEqual({
      matched: true,
      signature: 'SQLITE_ERROR',
    });
  });

  it('names the first declared signature present in the body', () => {
    const body = 'SequelizeDatabaseError and then SQLITE_ERROR';
    expect(evaluateErrorSignature(oracle, { status: 500, body })).toEqual({
      matched: true,
      signature: 'SQLITE_ERROR',
    });
  });

  it('does not match a signature on a non-error status (status is part of the oracle)', () => {
    expect(
      evaluateErrorSignature(oracle, { status: 200, body: 'SQLITE_ERROR echoed in a product' }),
    ).toEqual({
      matched: false,
    });
  });

  it('does not match a 500 without a declared signature', () => {
    expect(evaluateErrorSignature(oracle, { status: 500, body: 'internal server error' })).toEqual({
      matched: false,
    });
  });

  it('is case-sensitive: a lowercase variant is not the declared signature', () => {
    expect(evaluateErrorSignature(oracle, { status: 500, body: 'sqlite_error' })).toEqual({
      matched: false,
    });
  });

  it('never matches when no signatures are declared', () => {
    const empty: ErrorSignatureOracle = { ...oracle, signatures: [] };
    expect(evaluateErrorSignature(empty, { status: 500, body: 'SQLITE_ERROR' })).toEqual({
      matched: false,
    });
  });

  it('digests bodies deterministically without exposing them', () => {
    expect(bodyDigest('abc')).toBe(bodyDigest('abc'));
    expect(bodyDigest('abc')).not.toBe(bodyDigest('abd'));
    expect(bodyDigest('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
