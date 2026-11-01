import { describe, expect, it } from 'vitest';

import {
  ASSET_ID,
  KID,
  linkClaims,
  NOW_SECONDS,
  newKeyPair,
  resolverFor,
  signLink,
  testKeys,
} from './test-helpers.js';
import {
  SOC_PORTAL_LEEWAY_SECONDS,
  SOC_PORTAL_MAX_ASSETS,
  SOC_PORTAL_MAX_TOKEN_BYTES,
  SOC_PORTAL_MAX_TTL_SECONDS,
  verifySocPortalLink,
} from './token.js';

const resolve = resolverFor(testKeys);
const verify = (token: string, now = NOW_SECONDS) => verifySocPortalLink(token, resolve, now);

const b64u = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

describe('verifySocPortalLink', () => {
  it('accepts a valid, unexpired link and returns its claims', () => {
    const verdict = verify(signLink(linkClaims()));
    expect(verdict).toEqual({ ok: true, claims: linkClaims() });
  });

  it('accepts a link up to the leeway past its expiry, and refuses it beyond', () => {
    const token = signLink(linkClaims({ exp: NOW_SECONDS }));
    expect(verify(token, NOW_SECONDS + SOC_PORTAL_LEEWAY_SECONDS).ok).toBe(true);
    expect(verify(token, NOW_SECONDS + SOC_PORTAL_LEEWAY_SECONDS + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports a genuine link that is well past expiry as expired', () => {
    const token = signLink(linkClaims({ exp: NOW_SECONDS - 3600 }));
    expect(verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a tampered payload (signature no longer matches)', () => {
    const [header, , signature] = signLink(linkClaims()).split('.') as [string, string, string];
    const forged = b64u(
      JSON.stringify(linkClaims({ tenantId: '018f3c2e-7b1a-7c3d-9a4b-0123456789ff' })),
    );
    expect(verify(`${header}.${forged}.${signature}`)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a link signed by a different key, even under the same kid', () => {
    const intruder = newKeyPair();
    expect(verify(signLink(linkClaims(), intruder))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a genuine link re-issued for another tenant (cross-tenant confusion)', () => {
    const [header, , signature] = signLink(linkClaims()).split('.') as [string, string, string];
    const otherTenant = Buffer.from(
      JSON.stringify(linkClaims({ tenantId: '018f3c2e-7b1a-7c3d-9a4b-0123456789ff' })),
    ).toString('base64url');
    const verdict = verifySocPortalLink(
      `${header}.${otherTenant}.${signature}`,
      resolverFor(testKeys),
      NOW_SECONDS,
    );
    expect(verdict).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a link whose kid the verifier does not know', () => {
    expect(verify(signLink(linkClaims(), testKeys, 'retired-key'))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses an unsigned token (alg none) and an empty signature', () => {
    const header = b64u(JSON.stringify({ alg: 'none', kid: KID }));
    const body = b64u(JSON.stringify(linkClaims()));
    expect(verify(`${header}.${body}.`)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['wrong scope', linkClaims({ scope: 'console' })],
    ['an extra claim', linkClaims({ role: 'admin' })],
    ['no assets', linkClaims({ assetIds: [] })],
    [
      'too many assets',
      linkClaims({ assetIds: new Array(SOC_PORTAL_MAX_ASSETS + 1).fill(ASSET_ID) }),
    ],
    ['a non-uuid asset', linkClaims({ assetIds: ['not-a-uuid'] })],
    ['a non-uuid tenant', linkClaims({ tenantId: 'acme' })],
    ['a non-uuid jti', linkClaims({ jti: 'abc' })],
    ['a string expiry', linkClaims({ exp: 'soon' })],
    [
      'a missing tenant',
      Object.fromEntries(Object.entries(linkClaims()).filter(([k]) => k !== 'tenantId')),
    ],
  ])('refuses a link with %s', (_label, payload) => {
    expect(verify(signLink(payload))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a lifetime longer than the maximum (plus leeway) as invalid', () => {
    const tooLong = NOW_SECONDS + SOC_PORTAL_MAX_TTL_SECONDS + SOC_PORTAL_LEEWAY_SECONDS + 1;
    expect(verify(signLink(linkClaims({ exp: tooLong })))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const atLimit = NOW_SECONDS + SOC_PORTAL_MAX_TTL_SECONDS + SOC_PORTAL_LEEWAY_SECONDS;
    expect(verify(signLink(linkClaims({ exp: atLimit }))).ok).toBe(true);
  });

  it('refuses malformed, empty, oversized and non-compact input without parsing it', () => {
    expect(verify('')).toEqual({ ok: false, reason: 'invalid' });
    expect(verify('a.b')).toEqual({ ok: false, reason: 'invalid' });
    expect(verify('a.b.c.d')).toEqual({ ok: false, reason: 'invalid' });
    expect(verify('x'.repeat(SOC_PORTAL_MAX_TOKEN_BYTES + 1))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a non-JSON payload that is otherwise well formed', () => {
    const header = b64u(JSON.stringify({ alg: 'EdDSA', kid: KID }));
    const body = b64u('{not json');
    expect(verify(`${header}.${body}.AAAA`)).toEqual({ ok: false, reason: 'invalid' });
  });
});
