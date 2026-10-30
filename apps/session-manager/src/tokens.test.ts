import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SmUnauthenticatedError, type AuthFailureReason } from './errors.js';
import {
  CONTROL_TOKEN_PREFIX,
  createTokenVerifier,
  RUN_TOKEN_PREFIX,
  signControlToken,
  signRunToken,
  type TokenVerifier,
} from './tokens.js';

const RUN_KEY = 'r'.repeat(48);
const CONTROL_KEY = 'c'.repeat(48);
const TENANT = '0192f5a0-0000-7000-8000-000000000001';
const OTHER_TENANT = '0192f5a0-0000-7000-8000-000000000002';
const RUN = '0192f5a0-0000-7000-8000-0000000000aa';
const NOW_MS = 1_900_000_000_000;
const NOW_S = NOW_MS / 1000;

function verifier(now = NOW_MS): TokenVerifier {
  return createTokenVerifier({ runSecret: RUN_KEY, controlSecret: CONTROL_KEY, now: () => now });
}

/** Returns the reason a token was refused, or `undefined` when it verified. */
function refusal(v: TokenVerifier, header: string | undefined): AuthFailureReason | undefined {
  try {
    v.verify(header);
    return undefined;
  } catch (error) {
    if (error instanceof SmUnauthenticatedError) return error.reason;
    throw error;
  }
}

/** Builds a token from arbitrary claims, signed with the given key (forges bad claims for the tests). */
function forge(prefix: string, key: string, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', key).update(`${prefix}${payload}`).digest('base64url');
  return `${prefix}${payload}.${sig}`;
}

/** The base claims without the run id. */
function withoutRun(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(baseClaims).filter(([key]) => key !== 'rid'));
}

const baseClaims = {
  v: 1,
  aud: 'session-manager',
  tid: TENANT,
  rid: RUN,
  iat: NOW_S - 10,
  exp: NOW_S + 600,
};

describe('signRunToken / signControlToken round trip', () => {
  it('verifies a run-scoped token to its tenant and run', () => {
    const token = signRunToken(RUN_KEY, {
      tenantId: TENANT,
      runId: RUN,
      expiresAt: NOW_S + 600,
      issuedAt: NOW_S - 10,
    });
    expect(token.startsWith(RUN_TOKEN_PREFIX)).toBe(true);
    expect(verifier().verify(`Bearer ${token}`)).toEqual({
      kind: 'run',
      tenantId: TENANT,
      runId: RUN,
      expiresAt: NOW_S + 600,
    });
  });

  it('verifies a control-plane token to its tenant with no run', () => {
    const token = signControlToken(CONTROL_KEY, {
      tenantId: TENANT,
      expiresAt: NOW_S + 600,
      issuedAt: NOW_S - 10,
    });
    expect(token.startsWith(CONTROL_TOKEN_PREFIX)).toBe(true);
    const principal = verifier().verify(`Bearer ${token}`);
    expect(principal).toEqual({ kind: 'control', tenantId: TENANT, expiresAt: NOW_S + 600 });
    expect(principal).not.toHaveProperty('runId');
  });

  it('refuses a run-scoped mint without a run id', () => {
    expect(() => signRunToken(RUN_KEY, { tenantId: TENANT, expiresAt: NOW_S + 60 })).toThrow(
      SmUnauthenticatedError,
    );
  });

  it('accepts the Bearer scheme in any case and tolerates no extra whitespace inside the token', () => {
    const token = signControlToken(CONTROL_KEY, {
      tenantId: TENANT,
      expiresAt: NOW_S + 600,
      issuedAt: NOW_S - 10,
    });
    expect(refusal(verifier(), `bearer ${token}`)).toBeUndefined();
    expect(refusal(verifier(), `Bearer ${token} extra`)).toBe('not_bearer');
  });
});

describe('token refusals (fail closed, one reason each)', () => {
  const good = signRunToken(RUN_KEY, {
    tenantId: TENANT,
    runId: RUN,
    expiresAt: NOW_S + 600,
    issuedAt: NOW_S - 10,
  });

  it.each([
    ['no header', undefined, 'missing'],
    ['an empty header', '', 'missing'],
    ['a non-Bearer scheme', `Basic ${good}`, 'not_bearer'],
    ['a bare token without the scheme', good, 'not_bearer'],
    ['an unknown prefix', `Bearer bw_xxx_${good.slice(RUN_TOKEN_PREFIX.length)}`, 'wrong_prefix'],
    ['an oversized token', `Bearer ${RUN_TOKEN_PREFIX}${'A'.repeat(2100)}.x`, 'too_long'],
    ['no signature part', `Bearer ${RUN_TOKEN_PREFIX}abc`, 'malformed'],
    ['extra dot-separated parts', `Bearer ${RUN_TOKEN_PREFIX}a.b.c`, 'malformed'],
    ['non-base64url characters', `Bearer ${RUN_TOKEN_PREFIX}a+b.c`, 'malformed'],
  ] as const)('refuses %s', (_label, header, reason) => {
    expect(refusal(verifier(), header)).toBe(reason);
  });

  it('refuses a token whose payload was edited after signing', () => {
    const [payload = '', sig = ''] = good.slice(RUN_TOKEN_PREFIX.length).split('.');
    const edited = Buffer.from(
      JSON.stringify({ ...baseClaims, tid: OTHER_TENANT }),
      'utf8',
    ).toString('base64url');
    expect(edited).not.toBe(payload);
    expect(refusal(verifier(), `Bearer ${RUN_TOKEN_PREFIX}${edited}.${sig}`)).toBe('bad_signature');
  });

  it('refuses a control-plane token signed with the run key (a leaked run key cannot mint control tokens)', () => {
    const forged = forge(CONTROL_TOKEN_PREFIX, RUN_KEY, withoutRun());
    expect(refusal(verifier(), `Bearer ${forged}`)).toBe('bad_signature');
  });

  it('refuses a run-scoped token signed with the control key', () => {
    const forged = forge(RUN_TOKEN_PREFIX, CONTROL_KEY, baseClaims);
    expect(refusal(verifier(), `Bearer ${forged}`)).toBe('bad_signature');
  });

  it('refuses a token minted for another audience', () => {
    const forged = forge(RUN_TOKEN_PREFIX, RUN_KEY, { ...baseClaims, aud: 'sandbox-controller' });
    expect(refusal(verifier(), `Bearer ${forged}`)).toBe('wrong_audience');
  });

  it('refuses an expired token and a token expiring exactly now', () => {
    const expired = forge(RUN_TOKEN_PREFIX, RUN_KEY, {
      ...baseClaims,
      exp: NOW_S - 1,
      iat: NOW_S - 100,
    });
    const boundary = forge(RUN_TOKEN_PREFIX, RUN_KEY, {
      ...baseClaims,
      exp: NOW_S,
      iat: NOW_S - 100,
    });
    expect(refusal(verifier(), `Bearer ${expired}`)).toBe('expired');
    expect(refusal(verifier(), `Bearer ${boundary}`)).toBe('expired');
  });

  it('refuses an iat further in the future than the clock skew allows', () => {
    const future = forge(RUN_TOKEN_PREFIX, RUN_KEY, { ...baseClaims, iat: NOW_S + 3600 });
    expect(refusal(verifier(), `Bearer ${future}`)).toBe('not_yet_valid');
  });

  it('accepts an iat within the clock skew', () => {
    const skewed = forge(RUN_TOKEN_PREFIX, RUN_KEY, { ...baseClaims, iat: NOW_S + 10 });
    expect(refusal(verifier(), `Bearer ${skewed}`)).toBeUndefined();
  });

  it('refuses an iat at or after exp', () => {
    const inverted = forge(RUN_TOKEN_PREFIX, RUN_KEY, {
      ...baseClaims,
      iat: NOW_S + 300,
      exp: NOW_S + 300,
    });
    expect(refusal(verifier(), `Bearer ${inverted}`)).toBe('not_yet_valid');
  });

  it.each([
    ['a non-JSON payload', 'not json'],
    ['a JSON array', [1, 2]],
    ['a missing version', { ...baseClaims, v: undefined }],
    ['a wrong version', { ...baseClaims, v: 2 }],
    ['a non-UUID tenant', { ...baseClaims, tid: 'acme' }],
    ['a non-UUID run', { ...baseClaims, rid: 'run-1' }],
    ['a non-integer expiry', { ...baseClaims, exp: 1.5 }],
    ['a zero expiry', { ...baseClaims, exp: 0 }],
    ['a string issue time', { ...baseClaims, iat: 'now' }],
  ])('refuses a run token with %s as bad_claims', (_label, claims) => {
    const payload = Buffer.from(
      typeof claims === 'string' ? claims : JSON.stringify(claims),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', RUN_KEY)
      .update(`${RUN_TOKEN_PREFIX}${payload}`)
      .digest('base64url');
    expect(refusal(verifier(), `Bearer ${RUN_TOKEN_PREFIX}${payload}.${sig}`)).toBe('bad_claims');
  });

  it('refuses a run-scoped token that names no run', () => {
    expect(refusal(verifier(), `Bearer ${forge(RUN_TOKEN_PREFIX, RUN_KEY, withoutRun())}`)).toBe(
      'bad_claims',
    );
  });

  it('refuses a control-plane token that smuggles a run id', () => {
    const smuggled = forge(CONTROL_TOKEN_PREFIX, CONTROL_KEY, baseClaims);
    expect(refusal(verifier(), `Bearer ${smuggled}`)).toBe('bad_claims');
  });

  it('never echoes the token value in the refusal', () => {
    let message = '';
    try {
      verifier().verify(`Bearer ${RUN_TOKEN_PREFIX}zzz.yyy`);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('service token rejected');
    expect(message).not.toContain('zzz');
    expect(message).not.toContain('yyy');
  });
});
