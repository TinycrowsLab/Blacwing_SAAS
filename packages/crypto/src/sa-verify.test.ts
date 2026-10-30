import { generateKeyPairSync, type KeyObject, sign as edSign } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { ed25519Jwk, type Ed25519Jwk, signEnvelope } from './jws.js';
import {
  assertValidForTraffic,
  checkTestWindows,
  inWindow,
  isActive,
  SaNotValidError,
  type SaSigningSource,
  saSignedBytes,
  type VerifiableSa,
  verifyEnvelope,
} from './sa-verify.js';

const DAY_MS = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const T1 = Date.parse('2027-01-01T00:00:00.000Z');
const MID = new Date(Date.parse('2026-06-01T12:00:00.000Z'));
const KID = 'sa-key-1';
const APPROVED = { approverId: 'user-approver', version: 2 };

interface Key {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: Ed25519Jwk;
}

function makeKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { kid, privateKey, jwk: ed25519Jwk(kid, new Uint8Array(raw)) };
}

const key = makeKey(KID);
const jwks: readonly Ed25519Jwk[] = [key.jwk];

function source(overrides: Partial<SaSigningSource> = {}): SaSigningSource {
  return {
    publicId: 'sa-0001',
    assetIds: ['asset-a', 'asset-b'],
    scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
    maxIntrusiveness: 'active_safe',
    preApprovedTestClasses: ['auth.check'],
    defaultBudgets: { costUsd: 5, requests: 1000, wallClockMs: 3_600_000 },
    testWindows: [],
    validFrom: new Date(T0),
    expiresAt: new Date(T1),
    requesterId: 'user-requester',
    ...overrides,
  };
}

/** A stored, approved and signed SA exactly as the approval path writes it. */
async function signedSa(
  overrides: Partial<SaSigningSource> = {},
  signingKey: Key = key,
): Promise<VerifiableSa> {
  const body = source(overrides);
  const bytes = saSignedBytes(body, APPROVED);
  const signed = await signEnvelope(
    bytes,
    {
      kid: signingKey.kid,
      sign: (input) => Promise.resolve(new Uint8Array(edSign(null, input, signingKey.privateKey))),
    },
    Math.floor(T0 / 1000),
  );
  return {
    ...body,
    status: 'active',
    approverId: APPROVED.approverId,
    version: APPROVED.version,
    signature: signed.compact,
    signingKeyId: signed.kid,
    envelopeHash: signed.envelopeHash,
  };
}

const b64u = (value: string): string => Buffer.from(value).toString('base64url');

describe('saSignedBytes', () => {
  it('is independent of object key order inside the scope and budget JSON', () => {
    const a = saSignedBytes(
      source({ scopeRules: { rules: [{ effect: 'include', host: 'x.test', ports: [443] }] } }),
      APPROVED,
    );
    const b = saSignedBytes(
      source({ scopeRules: { rules: [{ ports: [443], host: 'x.test', effect: 'include' }] } }),
      APPROVED,
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('changes when the approver or the version changes, so approval is part of what is signed', () => {
    const base = Buffer.from(saSignedBytes(source(), APPROVED));
    const other = Buffer.from(saSignedBytes(source(), { ...APPROVED, approverId: 'user-b' }));
    const bumped = Buffer.from(saSignedBytes(source(), { ...APPROVED, version: 3 }));
    expect(base.equals(other)).toBe(false);
    expect(base.equals(bumped)).toBe(false);
  });

  it('refuses non-finite numbers rather than signing a wrong body', () => {
    expect(() =>
      saSignedBytes(source({ defaultBudgets: { costUsd: Number.NaN } }), APPROVED),
    ).toThrow();
  });
});

describe('verifyEnvelope', () => {
  it('accepts a freshly signed, active, in-window SA', async () => {
    const sa = await signedSa();
    expect(verifyEnvelope(sa, jwks, MID)).toEqual({ ok: true, reasons: [] });
  });

  it('reports TAMPERED for any changed signed field, and for a rewritten stored hash', async () => {
    const sa = await signedSa();
    const changed: VerifiableSa[] = [
      { ...sa, maxIntrusiveness: 'passive' },
      { ...sa, assetIds: ['asset-c'] },
      { ...sa, scopeRules: { rules: [{ effect: 'include', host: 'evil.test' }] } },
      { ...sa, defaultBudgets: { costUsd: 9999, requests: 1000, wallClockMs: 3_600_000 } },
      { ...sa, requesterId: 'someone-else' },
      { ...sa, version: 3 },
      { ...sa, approverId: 'user-other' },
      { ...sa, envelopeHash: 'f'.repeat(64) },
    ];
    for (const tampered of changed) {
      expect(verifyEnvelope(tampered, jwks, MID)).toEqual({ ok: false, reasons: ['TAMPERED'] });
    }
  });

  it('reports SIG_INVALID for a signature made by another key under the same kid', async () => {
    const impostor = makeKey(KID);
    const sa = await signedSa({}, impostor);
    expect(verifyEnvelope(sa, jwks, MID)).toEqual({ ok: false, reasons: ['SIG_INVALID'] });
  });

  it('reports SIG_INVALID for a malformed, algorithm-downgraded or wrong-typed detached JWS, without throwing', async () => {
    const sa = await signedSa();
    const [header, , sig] = (sa.signature ?? '').split('.') as [string, string, string];
    const noneHeader = b64u(
      JSON.stringify({ alg: 'none', kid: KID, typ: 'application/sa-envelope+jcs' }),
    );
    const wrongTyp = b64u(JSON.stringify({ alg: 'EdDSA', kid: KID, typ: 'JWT' }));
    const malformed = [
      'not-a-jws',
      `${header}.payloadnotempty.${sig}`,
      `${header}..`,
      `${header}..AAAA`,
      `${noneHeader}..${sig}`,
      `${wrongTyp}..${sig}`,
      `${header}..${'A'.repeat(86)}!`,
      `${header}..${Buffer.alloc(10).toString('base64url')}`,
    ];
    for (const signature of malformed) {
      expect(verifyEnvelope({ ...sa, signature }, jwks, MID)).toEqual({
        ok: false,
        reasons: ['SIG_INVALID'],
      });
    }
  });

  it('reports SIG_INVALID when the token kid differs from the recorded signing key id', async () => {
    const sa = await signedSa();
    const other = { ...sa, signingKeyId: 'sa-key-2' };
    expect(verifyEnvelope(other, [key.jwk, makeKey('sa-key-2').jwk], MID)).toEqual({
      ok: false,
      reasons: ['SIG_INVALID'],
    });
  });

  it('reports KID_UNKNOWN for an empty JWKS, a JWKS without the kid, or a malformed JWK (fail closed)', async () => {
    const sa = await signedSa();
    const expected = { ok: false, reasons: ['KID_UNKNOWN'] };
    expect(verifyEnvelope(sa, [], MID)).toEqual(expected);
    expect(verifyEnvelope(sa, [makeKey('other').jwk], MID)).toEqual(expected);
    expect(verifyEnvelope(sa, [{ ...key.jwk, x: 'AAAA' }], MID)).toEqual(expected);
    expect(verifyEnvelope(sa, [{ ...key.jwk, use: 'enc' as 'sig' }], MID)).toEqual(expected);
  });

  it('reports NOT_ACTIVE for a revoked, expired, draft or pending SA', async () => {
    const sa = await signedSa();
    for (const status of ['revoked', 'expired', 'draft', 'pending_approval']) {
      expect(verifyEnvelope({ ...sa, status }, jwks, MID)).toEqual({
        ok: false,
        reasons: ['NOT_ACTIVE'],
      });
    }
  });

  it('reports NOT_YET_VALID before validFrom and EXPIRED at and after expiresAt, at the exact boundary instants', async () => {
    const sa = await signedSa();
    expect(verifyEnvelope(sa, jwks, new Date(T0 - 1)).reasons).toEqual(['NOT_YET_VALID']);
    expect(verifyEnvelope(sa, jwks, new Date(T0)).ok).toBe(true);
    expect(verifyEnvelope(sa, jwks, new Date(T1 - 1)).ok).toBe(true);
    expect(verifyEnvelope(sa, jwks, new Date(T1)).reasons).toEqual(['EXPIRED']);
    expect(verifyEnvelope(sa, jwks, new Date(T1 + DAY_MS)).reasons).toEqual(['EXPIRED']);
  });

  it('applies clock skew to the validity bounds only, and never to the signature', async () => {
    const sa = await signedSa();
    const skew = { clockSkewSeconds: 30 };
    expect(verifyEnvelope(sa, jwks, new Date(T0 - 10_000), skew).ok).toBe(true);
    expect(verifyEnvelope(sa, jwks, new Date(T0 - 30_001), skew).reasons).toEqual([
      'NOT_YET_VALID',
    ]);
    expect(verifyEnvelope(sa, jwks, new Date(T1 + 29_999), skew).ok).toBe(true);
    expect(verifyEnvelope(sa, jwks, new Date(T1 + 30_000), skew).reasons).toEqual(['EXPIRED']);
    const tampered = { ...sa, maxIntrusiveness: 'passive' as const };
    expect(verifyEnvelope(tampered, jwks, MID, skew).reasons).toEqual(['TAMPERED']);
  });

  it('rejects a negative or fractional clock skew instead of widening the window', async () => {
    const sa = await signedSa();
    expect(() => verifyEnvelope(sa, jwks, MID, { clockSkewSeconds: -1 })).toThrow(RangeError);
    expect(() => verifyEnvelope(sa, jwks, MID, { clockSkewSeconds: 1.5 })).toThrow(RangeError);
  });

  it('fails closed for an invalid clock value', async () => {
    const sa = await signedSa();
    const result = verifyEnvelope(sa, jwks, new Date('not a date'));
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(['NOT_YET_VALID', 'EXPIRED']);
  });

  it('fails closed for an SA that was never approved, with no signed body to check', async () => {
    const sa = await signedSa();
    const unapproved = { ...sa, status: 'pending_approval', approverId: null, signature: null };
    expect(verifyEnvelope(unapproved, jwks, MID)).toEqual({
      ok: false,
      reasons: ['NOT_ACTIVE', 'SIG_INVALID'],
    });
  });

  it('reports every failure at once, so a revoked and expired SA shows both reasons', async () => {
    const sa = await signedSa();
    expect(verifyEnvelope({ ...sa, status: 'revoked' }, jwks, new Date(T1)).reasons).toEqual([
      'NOT_ACTIVE',
      'EXPIRED',
    ]);
  });

  it('is deterministic: the same inputs always give the same answer', async () => {
    const sa = await signedSa();
    expect(verifyEnvelope(sa, jwks, MID)).toEqual(verifyEnvelope(sa, jwks, MID));
  });

  it('holds for any approved version and any intrusiveness ceiling (property: verify after sign is ok)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10_000 }),
        fc.constantFrom('passive', 'active_safe', 'state_changing'),
        async (version, maxIntrusiveness) => {
          const body = source({ maxIntrusiveness });
          const bytes = saSignedBytes(body, { approverId: 'user-approver', version });
          const signed = await signEnvelope(
            bytes,
            {
              kid: KID,
              sign: (input) => Promise.resolve(new Uint8Array(edSign(null, input, key.privateKey))),
            },
            1,
          );
          const sa: VerifiableSa = {
            ...body,
            status: 'active',
            approverId: 'user-approver',
            version,
            signature: signed.compact,
            signingKeyId: KID,
            envelopeHash: signed.envelopeHash,
          };
          expect(verifyEnvelope(sa, jwks, MID).ok).toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('isActive and assertValidForTraffic', () => {
  it('isActive needs an active status and an in-bounds instant', async () => {
    const sa = await signedSa();
    expect(isActive(sa, MID)).toBe(true);
    expect(isActive(sa, new Date(T1))).toBe(false);
    expect(isActive(sa, new Date(T0 - 1))).toBe(false);
    expect(isActive({ ...sa, status: 'revoked' }, MID)).toBe(false);
  });

  it('does not throw for a valid SA', async () => {
    const sa = await signedSa();
    expect(() => {
      assertValidForTraffic(sa, jwks, MID);
    }).not.toThrow();
  });

  it('throws SaNotValidError carrying the first failure and the AUTHZ_SA_NOT_VALID code', async () => {
    const sa = await signedSa();
    let caught: unknown;
    try {
      assertValidForTraffic(sa, jwks, new Date(T1));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaNotValidError);
    expect(caught).toBeInstanceOf(AppError);
    const error = caught as SaNotValidError;
    expect(error.code).toBe('AUTHZ_SA_NOT_VALID');
    expect(error.reason).toBe('EXPIRED');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(403);
  });

  it('throws for a revoked SA even when its signature is fine', async () => {
    const sa = await signedSa();
    expect(() => {
      assertValidForTraffic({ ...sa, status: 'revoked' }, jwks, MID);
    }).toThrow(SaNotValidError);
  });
});

describe('checkTestWindows and inWindow', () => {
  const HOUR = 3_600_000;
  const london = { cron: '0 9 * * *', timezone: 'Europe/London', durationMs: HOUR };
  const at = (iso: string): Date => new Date(Date.parse(iso));

  it('opens a window at its start and closes it exactly at start + duration', () => {
    // 09:00 GMT on 2026-03-28 (before the spring change).
    expect(inWindow([london], at('2026-03-28T09:00:00.000Z'))).toBe(true);
    expect(inWindow([london], at('2026-03-28T09:59:59.999Z'))).toBe(true);
    expect(inWindow([london], at('2026-03-28T10:00:00.000Z'))).toBe(false);
    expect(inWindow([london], at('2026-03-28T08:59:59.999Z'))).toBe(false);
  });

  it('keeps 09:00 London local across the spring DST change (UTC opening moves from 09:00 to 08:00)', () => {
    // 09:00 BST on 2026-03-30 is 08:00 UTC: the window must open then, not at 09:00 UTC.
    expect(inWindow([london], at('2026-03-30T08:00:00.000Z'))).toBe(true);
    expect(inWindow([london], at('2026-03-30T08:59:59.999Z'))).toBe(true);
    expect(inWindow([london], at('2026-03-30T09:00:00.000Z'))).toBe(false);
    expect(inWindow([london], at('2026-03-30T07:59:59.999Z'))).toBe(false);
  });

  it('keeps 09:00 London local across the autumn DST change (opening moves back to 09:00 UTC)', () => {
    expect(inWindow([london], at('2026-10-26T09:00:00.000Z'))).toBe(true);
    expect(inWindow([london], at('2026-10-26T08:00:00.000Z'))).toBe(false);
  });

  it('is open when any one window is open, and reports each unevaluable window as invalid', () => {
    const later = { cron: '0 15 * * *', timezone: 'UTC', durationMs: HOUR };
    const check = checkTestWindows(
      [
        { cron: '0 9 * * *', timezone: 'Mars/Olympus', durationMs: HOUR },
        { cron: 'not a cron', timezone: 'UTC', durationMs: HOUR },
        later,
      ],
      at('2026-06-01T15:30:00.000Z'),
    );
    expect(check.open).toBe(true);
    expect(check.invalid).toEqual(['WINDOW_TZ_INVALID', 'WINDOW_CRON_INVALID']);
  });

  it('treats only-invalid windows as closed (fail closed)', () => {
    expect(inWindow([{ cron: '0 9 * * *', timezone: 'Not/AZone', durationMs: HOUR }], MID)).toBe(
      false,
    );
    expect(
      checkTestWindows([{ cron: '0 9 * * *', timezone: 'Not/AZone', durationMs: HOUR }], MID),
    ).toEqual({ open: false, invalid: ['WINDOW_TZ_INVALID'] });
  });

  it('places no window restriction on an SA with an empty window list', () => {
    expect(inWindow([], MID)).toBe(true);
    expect(checkTestWindows([], MID)).toEqual({ open: true, invalid: [] });
  });
});
