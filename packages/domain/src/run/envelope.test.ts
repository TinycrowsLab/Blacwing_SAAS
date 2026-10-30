import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RUN_ENVELOPE_TYP, type RunEnvelope } from '@blackwing/contracts';
import {
  canonicaliseValue,
  type EnvelopeSigningKey,
  type JwsKeyResolver,
  type JwsSigner,
  publicKeyOf,
  signCanonicalJws,
} from '@blackwing/crypto';

import { buildRunEnvelope, signRunEnvelope, verifyRunEnvelope } from './envelope.js';

type TestKey = EnvelopeSigningKey & { readonly signer: JwsSigner };

const TENANT = '0190a5d0-1111-7111-8111-111111111111';
const SA = '0190a5d0-3333-7333-8333-333333333333';
const ASSET_A = '0190a5d0-4444-7444-8444-444444444444';
const ASSET_B = '0190a5d0-5555-7555-8555-555555555555';
const RUN = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
const NOW = new Date('2026-10-29T10:00:00.000Z');
const APPROVED = '2026-10-29T10:00:00.000Z';
const SA_EXPIRES = '2026-10-29T18:00:00.000Z';
const WINDOW_ENDS = '2026-10-29T12:00:00.000Z';

function draft(over: Partial<RunEnvelope> = {}): RunEnvelope {
  return {
    runId: RUN,
    tenantId: TENANT,
    assetIds: [ASSET_A, ASSET_B],
    scopeRules: { rules: [{ effect: 'include', host: 'app.lab.test' }] },
    testWindows: [{ cron: '0 * * * *', timezone: 'UTC', durationMs: 3_600_000 }],
    maxIntrusiveness: 'active_safe',
    approvedTestCaseIds: ['tc-b', 'tc-a'],
    budgets: { costCapUsd: 10, maxRequests: 1000, maxDurationMs: 3_600_000 },
    saId: SA,
    saExpiresAt: SA_EXPIRES,
    runWindowEndsAt: WINDOW_ENDS,
    approvedPlanVersion: 2,
    approverId: 'user-approver',
    approvedAt: APPROVED,
    envelopeVersion: 1,
    ...over,
  };
}

/** A signer in the shape OpenBao Transit gives: only signatures leave the key. */
function keyFor(kid: string, privateKey = generateKeyPairSync('ed25519').privateKey): TestKey {
  return {
    kid,
    signer: { kid, privateKey },
    sign: (input) =>
      Promise.resolve(new Uint8Array(nodeSign(null, Buffer.from(input), privateKey))),
  };
}

const resolverFor =
  (...keys: readonly TestKey[]): JwsKeyResolver =>
  (kid) => {
    const key = keys.find((k) => k.kid === kid);
    return key === undefined ? undefined : publicKeyOf(key.signer);
  };

async function signed(over: Partial<RunEnvelope> = {}, key = keyFor('bw-sa-signing:v1')) {
  const envelope = buildRunEnvelope(draft(over), NOW);
  return { key, result: await signRunEnvelope(envelope, key) };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('buildRunEnvelope', () => {
  it('accepts a complete envelope and sorts the identifier lists', () => {
    const built = buildRunEnvelope(draft(), NOW);
    expect(built.assetIds).toEqual([ASSET_A, ASSET_B]);
    expect(built.approvedTestCaseIds).toEqual(['tc-a', 'tc-b']);
  });

  it('refuses to sign when the standing authorisation has expired by now', () => {
    expect(codeOf(() => buildRunEnvelope(draft(), new Date(SA_EXPIRES)))).toBe(
      'ENVELOPE_SA_EXPIRED',
    );
    expect(codeOf(() => buildRunEnvelope(draft(), new Date('2026-10-29T19:00:00.000Z')))).toBe(
      'ENVELOPE_SA_EXPIRED',
    );
  });

  it('refuses to sign when the run window has closed by now', () => {
    expect(codeOf(() => buildRunEnvelope(draft(), new Date(WINDOW_ENDS)))).toBe(
      'ENVELOPE_WINDOW_CLOSED',
    );
  });

  it('accepts a run with no window, bounded only by the authorisation', () => {
    expect(() => buildRunEnvelope(draft({ runWindowEndsAt: null }), NOW)).not.toThrow();
  });

  it('refuses a destructive intrusiveness class, which an SA can never grant (§8.3)', () => {
    expect(
      codeOf(() => buildRunEnvelope(draft({ maxIntrusiveness: 'destructive' as never }), NOW)),
    ).toBe('ENVELOPE_VERIFICATION_FAILED');
  });

  it('refuses duplicate asset ids rather than silently de-duplicating them', () => {
    expect(codeOf(() => buildRunEnvelope(draft({ assetIds: [ASSET_A, ASSET_A] }), NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });

  it('refuses a scope with no include rule (default deny)', () => {
    expect(
      codeOf(() =>
        buildRunEnvelope(
          draft({ scopeRules: { rules: [{ effect: 'exclude', host: 'x.lab.test' }] } }),
          NOW,
        ),
      ),
    ).toBe('ENVELOPE_VERIFICATION_FAILED');
  });

  it('refuses an envelope with an unknown field (strict schema)', () => {
    expect(
      codeOf(() => buildRunEnvelope({ ...draft(), extra: 1 } as unknown as RunEnvelope, NOW)),
    ).toBe('ENVELOPE_VERIFICATION_FAILED');
  });

  it('refuses scope rules that push the canonical body over the byte cap (bounded scope)', () => {
    const rules = Array.from({ length: 1000 }, (_, i) => ({
      effect: 'include' as const,
      host: `h${String(i)}.${'a'.repeat(50)}.lab.test`,
      paths: Array.from({ length: 50 }, (__, j) => `/p${String(j)}/${'b'.repeat(40)}`),
    }));
    expect(codeOf(() => buildRunEnvelope(draft({ scopeRules: { rules } }), NOW))).toBe(
      'ENVELOPE_TOO_LARGE',
    );
  });
});

describe('signRunEnvelope and verifyRunEnvelope', () => {
  it('approving a run produces a JWS that verifyRunEnvelope validates to the same envelope', async () => {
    const { key, result } = await signed();
    const verified = verifyRunEnvelope(result.jws, resolverFor(key), new Date(APPROVED));
    expect(verified).toEqual(result.envelope);
    expect(result.signingKeyId).toBe('bw-sa-signing:v1');
    expect(result.jws.split('.')).toHaveLength(3);
  });

  it('the token header carries the run envelope type and the signing kid', async () => {
    const { result } = await signed();
    const header = JSON.parse(
      Buffer.from(result.jws.split('.')[0] ?? '', 'base64url').toString(),
    ) as unknown;
    expect(header).toEqual({ alg: 'EdDSA', kid: 'bw-sa-signing:v1', typ: RUN_ENVELOPE_TYP });
  });

  it('is deterministic: the same envelope yields the same envelopeHash, however it was ordered', async () => {
    const a = await signRunEnvelope(buildRunEnvelope(draft(), NOW), keyFor('k'));
    const reordered = draft({
      assetIds: [ASSET_B, ASSET_A],
      approvedTestCaseIds: ['tc-a', 'tc-b'],
    });
    const b = await signRunEnvelope(buildRunEnvelope(reordered, NOW), keyFor('k'));
    expect(a.envelopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.envelopeHash).toBe(a.envelopeHash);
  });

  it('a changed field changes the envelopeHash', async () => {
    const a = await signRunEnvelope(buildRunEnvelope(draft(), NOW), keyFor('k'));
    const b = await signRunEnvelope(
      buildRunEnvelope(draft({ maxIntrusiveness: 'passive' }), NOW),
      keyFor('k'),
    );
    expect(b.envelopeHash).not.toBe(a.envelopeHash);
  });

  it('fails closed when the signer fails, returning no unsigned envelope', async () => {
    const down: EnvelopeSigningKey = { kid: 'k', sign: () => Promise.reject(new Error('sealed')) };
    await expect(signRunEnvelope(buildRunEnvelope(draft(), NOW), down)).rejects.toThrow('sealed');
  });

  it('a tampered payload fails verification', async () => {
    const { key, result } = await signed();
    const [header, , signature] = result.jws.split('.') as [string, string, string];
    const forged = draft({ maxIntrusiveness: 'destructive' as never });
    const body = Buffer.from(JSON.stringify(forged)).toString('base64url');
    expect(
      codeOf(() => verifyRunEnvelope(`${header}.${body}.${signature}`, resolverFor(key), NOW)),
    ).toBe('ENVELOPE_VERIFICATION_FAILED');
  });

  it('a tampered signature fails verification', async () => {
    const { key, result } = await signed();
    const [header, body] = result.jws.split('.') as [string, string];
    const bad = `${header}.${body}.${Buffer.alloc(64, 1).toString('base64url')}`;
    expect(codeOf(() => verifyRunEnvelope(bad, resolverFor(key), NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });

  it('an unknown kid fails verification (no key, no trust)', async () => {
    const { result } = await signed();
    expect(codeOf(() => verifyRunEnvelope(result.jws, () => undefined, NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });

  it('a token signed under another type is refused even with a valid signature', async () => {
    const key = keyFor('k');
    const canonical = canonicaliseValue(buildRunEnvelope(draft(), NOW));
    const otherType = await signCanonicalJws(canonical, key, 'application/sa-envelope+jcs');
    expect(codeOf(() => verifyRunEnvelope(otherType, resolverFor(key), NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });

  it('a validly signed payload that is not a run envelope is refused', async () => {
    const key = keyFor('k');
    const token = await signCanonicalJws(
      new TextEncoder().encode('{"hello":"world"}'),
      key,
      RUN_ENVELOPE_TYP,
    );
    expect(codeOf(() => verifyRunEnvelope(token, resolverFor(key), NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });

  it('verifies an envelope signed under an older key after a rotation, by its pinned kid', async () => {
    const v1 = keyFor('bw-sa-signing:v1');
    const v2 = keyFor('bw-sa-signing:v2');
    const { result } = await signed({}, v1);
    expect(verifyRunEnvelope(result.jws, resolverFor(v1, v2), NOW).runId).toBe(RUN);
  });

  it('refuses an envelope whose approval lies beyond the clock-skew tolerance in the future', async () => {
    const { key, result } = await signed();
    const early = new Date(Date.parse(APPROVED) - 31_000);
    expect(codeOf(() => verifyRunEnvelope(result.jws, resolverFor(key), early))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });

  it('accepts an approval 30 seconds ahead of the verifier (within the skew tolerance)', async () => {
    const { key, result } = await signed();
    const lagging = new Date(Date.parse(APPROVED) - 30_000);
    expect(() => verifyRunEnvelope(result.jws, resolverFor(key), lagging)).not.toThrow();
  });

  it('refuses after the SA expires at verification time', async () => {
    const { key, result } = await signed();
    expect(
      codeOf(() => verifyRunEnvelope(result.jws, resolverFor(key), new Date(SA_EXPIRES))),
    ).toBe('ENVELOPE_SA_EXPIRED');
  });

  it('expires the envelope early by the skew, never late (a fast verifier clock cannot extend it)', async () => {
    const { key, result } = await signed();
    const almost = new Date(Date.parse(SA_EXPIRES) - 10_000);
    expect(codeOf(() => verifyRunEnvelope(result.jws, resolverFor(key), almost))).toBe(
      'ENVELOPE_SA_EXPIRED',
    );
  });

  it('refuses after the run window closes at verification time', async () => {
    const { key, result } = await signed();
    expect(
      codeOf(() => verifyRunEnvelope(result.jws, resolverFor(key), new Date(WINDOW_ENDS))),
    ).toBe('ENVELOPE_WINDOW_CLOSED');
  });

  it('refuses a token larger than the envelope cap before parsing it', () => {
    const huge = `${'a'.repeat(70 * 1024)}.b.c`;
    expect(codeOf(() => verifyRunEnvelope(huge, () => undefined, NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });

  it('refuses a malformed token (wrong part count, bad base64, alg none)', () => {
    expect(codeOf(() => verifyRunEnvelope('not-a-jws', () => undefined, NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
    expect(codeOf(() => verifyRunEnvelope('a!.b.c', () => undefined, NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: RUN_ENVELOPE_TYP })).toString('base64url')}.e30.`;
    expect(codeOf(() => verifyRunEnvelope(none, () => undefined, NOW))).toBe(
      'ENVELOPE_VERIFICATION_FAILED',
    );
  });
});
