import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createServiceTokenVerifier,
  SERVICE_TOKEN_MAX_TTL_SECONDS,
  ServiceAuthError,
  signServiceToken,
} from './service-auth.js';

const KEY = 'service-token-key-0123456789abcdef-xyz';
const NOW_S = 1_800_000_000;
const now = () => NOW_S * 1000;
const verifier = (extra: Partial<Parameters<typeof createServiceTokenVerifier>[0]> = {}) =>
  createServiceTokenVerifier({ key: KEY, now, ...extra });
const token = (over: Partial<Parameters<typeof signServiceToken>[1]> = {}, key = KEY) =>
  signServiceToken(key, {
    service: 'egress-gateway',
    tokenId: 'tok-1',
    issuedAt: NOW_S - 10,
    expiresAt: NOW_S + 600,
    ...over,
  });
const reason = async (authorization: string | undefined, v = verifier()): Promise<string> =>
  v.verify(authorization).then(
    () => 'accepted',
    (e: unknown) =>
      e instanceof ServiceAuthError && e.httpStatus === 401 ? e.reason : 'wrong error',
  );
const signWith = (key: string, payload: string): string =>
  createHmac('sha256', key).update(`bwsvc_${payload}`).digest('base64url');
/** A token with arbitrary claims and a VALID signature, to test claim checks. */
const forge = (claims: Record<string, unknown>): string => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `bwsvc_${payload}.${signWith(KEY, payload)}`;
};

const base = {
  v: 1,
  aud: 'secrets.resolve',
  svc: 'egress-gateway',
  jti: 'j1',
  iat: NOW_S,
  exp: NOW_S + 60,
};

describe('service token verifier', () => {
  it('accepts a valid token and names the service', async () => {
    expect(await verifier().verify(`Bearer ${token()}`)).toEqual({
      service: 'egress-gateway',
      tokenId: 'tok-1',
    });
  });

  it('accepts every platform service and nothing else', async () => {
    for (const service of [
      'session-manager',
      'model-gateway',
      'worker:connectors',
      'worker:notify',
    ] as const) {
      expect((await verifier().verify(`Bearer ${token({ service })}`)).service).toBe(service);
    }
    expect(await reason(`Bearer ${forge({ ...base, svc: 'sandbox' })}`)).toBe('unknown_service');
    expect(await reason(`Bearer ${forge({ ...base, svc: 'worker:other' })}`)).toBe(
      'unknown_service',
    );
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['Basic abc', 'not_bearer'],
    ['Bearer', 'not_bearer'],
    [`Bearer ${'a'.repeat(2000)}`, 'too_long'],
    ['Bearer bwrun_abc.def', 'wrong_prefix'],
    ['Bearer bwsvc_onlyonepart', 'malformed'],
    ['Bearer bwsvc_a.b.c', 'malformed'],
    ['Bearer bwsvc_a!.b', 'malformed'],
    [`Bearer bwsvc_${Buffer.from('{}').toString('base64url')}.${'A'.repeat(43)}`, 'bad_signature'],
  ])('rejects %j as %s', async (authorization, expected) => {
    expect(await reason(authorization)).toBe(expected);
  });

  it('rejects a token signed with another key or with a tampered payload', async () => {
    expect(await reason(`Bearer ${token({}, 'another-key-0123456789abcdef0123456789')}`)).toBe(
      'bad_signature',
    );
    const [head, sig] = token().split('.');
    const tampered = Buffer.from(JSON.stringify({ ...base, svc: 'model-gateway' })).toString(
      'base64url',
    );
    expect(await reason(`Bearer ${head?.slice(0, 6)}${tampered}.${sig}`)).toBe('bad_signature');
  });

  it('rejects malformed or foreign claims', async () => {
    expect(await reason(`Bearer ${forge({ ...base, aud: 'broker' })}`)).toBe('bad_claims');
    expect(await reason(`Bearer ${forge({ ...base, v: 2 })}`)).toBe('bad_claims');
    expect(await reason(`Bearer ${forge({ ...base, jti: 'has space' })}`)).toBe('bad_claims');
    expect(await reason(`Bearer ${forge({ ...base, exp: 'soon' })}`)).toBe('bad_claims');
    const payload = Buffer.from('null').toString('base64url');
    expect(await reason(`Bearer bwsvc_${payload}.${signWith(KEY, payload)}`)).toBe('bad_claims');
    const text = Buffer.from('not json').toString('base64url');
    expect(await reason(`Bearer bwsvc_${text}.${signWith(KEY, text)}`)).toBe('bad_claims');
  });

  it('rejects expired, future-dated and over-long tokens', async () => {
    expect(await reason(`Bearer ${token({ issuedAt: NOW_S - 100, expiresAt: NOW_S - 1 })}`)).toBe(
      'expired',
    );
    expect(
      await reason(`Bearer ${token({ issuedAt: NOW_S + 3600, expiresAt: NOW_S + 7200 })}`),
    ).toBe('not_yet_valid');
    expect(
      await reason(
        `Bearer ${token({ issuedAt: NOW_S - 10, expiresAt: NOW_S - 10 + SERVICE_TOKEN_MAX_TTL_SECONDS + 1 })}`,
      ),
    ).toBe('ttl_too_long');
  });

  it('rejects a revoked token, and fails closed when the revocation store fails', async () => {
    const revoked = verifier({ revocations: { isRevoked: (id) => id === 'tok-1' } });
    expect(await reason(`Bearer ${token()}`, revoked)).toBe('revoked');
    expect((await revoked.verify(`Bearer ${token({ tokenId: 'tok-2' })}`)).tokenId).toBe('tok-2');
    const broken = verifier({
      revocations: { isRevoked: () => Promise.reject(new Error('valkey down')) },
    });
    expect(await reason(`Bearer ${token()}`, broken)).toBe('revoked');
  });

  it('refuses to start with a short key and never echoes the token in the error', () => {
    expect(() => createServiceTokenVerifier({ key: 'short' })).toThrowError(/at least 32/);
    const error = new ServiceAuthError('bad_signature');
    expect(error.code).toBe('SERVICE_AUTH_FAILED');
    expect(JSON.stringify(error)).not.toContain('bwsvc_');
  });
});
