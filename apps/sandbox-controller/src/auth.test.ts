import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createHmacRunTokenVerifier,
  isProtectedPath,
  MAX_RUN_TOKEN_LENGTH,
  signRunToken,
} from './auth.js';
import { SbxUnauthenticatedError } from './errors.js';

const SECRET = 's'.repeat(48);
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const TENANT = '0192f5a0-0000-7000-8000-000000000001';
const RUN = '0192f5a0-0000-7000-8000-0000000000aa';

const verifier = createHmacRunTokenVerifier({ secret: SECRET, now: () => NOW_MS });

function token(
  overrides: Partial<Parameters<typeof signRunToken>[1]> = {},
  secret = SECRET,
): string {
  return signRunToken(secret, {
    tenantId: TENANT,
    runId: RUN,
    issuedAt: NOW_S - 10,
    expiresAt: NOW_S + 600,
    ...overrides,
  });
}

/** Signs an arbitrary claims object, to exercise claim validation behind a valid signature. */
function rawToken(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`bw_run_${payload}`).digest('base64url');
  return `bw_run_${payload}.${sig}`;
}

function reasonFor(header: string | undefined): string {
  try {
    verifier.verify(header);
  } catch (error) {
    if (error instanceof SbxUnauthenticatedError) {
      expect(error.code).toBe('SBX_UNAUTHENTICATED');
      expect(error.httpStatus).toBe(401);
      return error.reason;
    }
    throw error;
  }
  throw new Error('expected the token to be rejected');
}

describe('run-scoped token verification', () => {
  it('verifies a valid token and extracts tenant and run', () => {
    expect(verifier.verify(`Bearer ${token()}`)).toEqual({
      tenantId: TENANT,
      runId: RUN,
      expiresAt: NOW_S + 600,
    });
  });

  it('accepts the scheme case-insensitively', () => {
    expect(verifier.verify(`bearer ${token()}`).runId).toBe(RUN);
  });

  it.each([
    ['no header', undefined, 'missing'],
    ['an empty header', '', 'missing'],
    ['a Basic header', 'Basic dXNlcjpwdw==', 'not_bearer'],
    ['a bearer without a token', 'Bearer ', 'not_bearer'],
    ['a PAT instead of a run token', 'Bearer bw_pat_abc', 'wrong_prefix'],
    ['three segments', `Bearer ${token()}.x`, 'malformed'],
    ['a non-base64url segment', 'Bearer bw_run_a+b.c', 'malformed'],
    ['an oversized token', `Bearer bw_run_${'a'.repeat(MAX_RUN_TOKEN_LENGTH)}.b`, 'too_long'],
  ])('rejects %s', (_label, header, reason) => {
    expect(reasonFor(header)).toBe(reason);
  });

  it('rejects a token signed with another key', () => {
    expect(reasonFor(`Bearer ${token({}, 'x'.repeat(48))}`)).toBe('bad_signature');
  });

  it('rejects a token whose payload was altered after signing', () => {
    const [payload, sig] = token().slice('bw_run_'.length).split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...claims, tid: RUN })).toString('base64url');
    expect(reasonFor(`Bearer bw_run_${forged}.${sig ?? ''}`)).toBe('bad_signature');
  });

  it('rejects an expired token', () => {
    expect(reasonFor(`Bearer ${token({ issuedAt: NOW_S - 100, expiresAt: NOW_S })}`)).toBe(
      'expired',
    );
  });

  it('rejects a token issued in the future beyond the skew', () => {
    expect(reasonFor(`Bearer ${token({ issuedAt: NOW_S + 120, expiresAt: NOW_S + 600 })}`)).toBe(
      'not_yet_valid',
    );
  });

  it('rejects a token minted for another service', () => {
    expect(reasonFor(`Bearer ${token({ audience: 'run-broker' })}`)).toBe('wrong_audience');
  });

  it.each([
    [
      'a non-UUID tenant',
      { v: 1, aud: 'sandbox-controller', tid: 'acme', rid: RUN, iat: NOW_S, exp: NOW_S + 60 },
    ],
    [
      'a missing run',
      { v: 1, aud: 'sandbox-controller', tid: TENANT, iat: NOW_S, exp: NOW_S + 60 },
    ],
    [
      'an unknown version',
      { v: 2, aud: 'sandbox-controller', tid: TENANT, rid: RUN, iat: NOW_S, exp: NOW_S + 60 },
    ],
    [
      'an extra claim',
      {
        v: 1,
        aud: 'sandbox-controller',
        tid: TENANT,
        rid: RUN,
        iat: NOW_S,
        exp: NOW_S + 60,
        admin: true,
      },
    ],
    ['a non-object payload', 'hello'],
  ])('rejects %s behind a valid signature', (_label, claims) => {
    expect(reasonFor(`Bearer ${rawToken(claims)}`)).toBe('bad_claims');
  });

  it('never puts the token in the error', () => {
    const t = token({}, 'x'.repeat(48));
    let caught: unknown;
    try {
      verifier.verify(`Bearer ${t}`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SbxUnauthenticatedError);
    expect(String(caught)).not.toContain(t);
    expect(JSON.stringify(caught)).not.toContain(t);
    expect((caught as SbxUnauthenticatedError).detail).not.toContain(t);
  });
});

describe('isProtectedPath', () => {
  it.each([
    ['/internal/sandboxes', true],
    ['/internal/sandboxes/', true],
    ['/internal/sandboxes/sbx-1?x=1', true],
    ['//internal//sandboxes/x', true],
    ['/internal/%73andboxes/x', true],
    ['/INTERNAL/Sandboxes/x', true],
    ['/internal/sandboxes%2Fx', true],
    ['/internal/%E0%A4%A', true],
    ['/internal/sandboxesx', false],
    ['/healthz', false],
    ['/readyz', false],
    ['/metrics?internal/sandboxes', false],
  ])('%s -> %s', (url, expected) => {
    expect(isProtectedPath(url)).toBe(expected);
  });
});
