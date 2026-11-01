import { describe, expect, it } from 'vitest';

import { openPortalSession, sealPortalSession } from './session.js';
import {
  ASSET_ID,
  JTI,
  NOW_SECONDS,
  portalConfig,
  SESSION_SECRET,
  TENANT_ID,
} from './test-helpers.js';
import { socPortalClaimsSchema } from './token.js';
import { SOC_PORTAL_COOKIE } from '../auth/cookies.js';
import { deriveKey, seal } from '../auth/seal.js';

const key = portalConfig().sessionKey;
const claims = socPortalClaimsSchema.parse({
  tenantId: TENANT_ID,
  scope: 'soc_portal',
  assetIds: [ASSET_ID],
  jti: JTI,
  exp: NOW_SECONDS + 3600,
});

/** The value the cookie carries, read back from its `Set-Cookie` string. */
const valueOf = (setCookie: string): string => {
  const match = /^__Host-bw_soc_portal=([^;]+);/.exec(setCookie);
  if (match === null) throw new Error('no portal cookie in the Set-Cookie value');
  return match[1] ?? '';
};

describe('sealPortalSession', () => {
  it('sets a __Host- httpOnly, Secure, SameSite=Lax cookie that lasts until the link expires', () => {
    const setCookie = sealPortalSession(key, claims, NOW_SECONDS);
    expect(setCookie.startsWith(`${SOC_PORTAL_COOKIE}=`)).toBe(true);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=3600');
  });

  it('does not leak the tenant or asset ids in the cookie value', () => {
    const value = valueOf(sealPortalSession(key, claims, NOW_SECONDS));
    expect(value).not.toContain(TENANT_ID);
    expect(value).not.toContain(ASSET_ID);
  });
});

describe('openPortalSession', () => {
  it('returns the sealed claims while the link is still live', () => {
    const value = valueOf(sealPortalSession(key, claims, NOW_SECONDS));
    expect(openPortalSession(key, value, NOW_SECONDS + 60)).toEqual(claims);
  });

  it('returns null once the sealed session has expired', () => {
    const value = valueOf(sealPortalSession(key, claims, NOW_SECONDS));
    expect(openPortalSession(key, value, claims.exp + 1)).toBeNull();
  });

  it('returns null for an absent or empty cookie', () => {
    expect(openPortalSession(key, undefined, NOW_SECONDS)).toBeNull();
    expect(openPortalSession(key, '', NOW_SECONDS)).toBeNull();
  });

  it('returns null for a value sealed under another key', () => {
    const value = valueOf(sealPortalSession(key, claims, NOW_SECONDS));
    const other = deriveKey(`${SESSION_SECRET}-rotated-elsewhere`);
    expect(openPortalSession(other, value, NOW_SECONDS)).toBeNull();
  });

  it('returns null for a tampered value', () => {
    const value = valueOf(sealPortalSession(key, claims, NOW_SECONDS));
    const flipped = `${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(openPortalSession(key, flipped, NOW_SECONDS)).toBeNull();
  });

  it('does not accept a sealed value from another purpose (a console session)', () => {
    const foreign = seal(key, 'web-session', claims, 3600_000, NOW_SECONDS * 1000);
    expect(openPortalSession(key, foreign, NOW_SECONDS)).toBeNull();
  });

  it('returns null when the sealed payload is not a portal claim set', () => {
    const malformed = seal(
      key,
      'soc-portal-session',
      { scope: 'console' },
      3600_000,
      NOW_SECONDS * 1000,
    );
    expect(openPortalSession(key, malformed, NOW_SECONDS)).toBeNull();
  });
});
