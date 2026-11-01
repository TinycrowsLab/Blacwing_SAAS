import { describe, expect, it } from 'vitest';

import { resolvePortalAccess } from './access.js';
import { ASSET_ID, JTI, NOW_SECONDS, TENANT_ID } from './test-helpers.js';
import { socPortalClaimsSchema } from './token.js';

import type { Session } from '../session.js';

const claims = socPortalClaimsSchema.parse({
  tenantId: TENANT_ID,
  scope: 'soc_portal',
  assetIds: [ASSET_ID],
  jti: JTI,
  exp: NOW_SECONDS + 3600,
});

const session = (roles: string[]): Session => ({
  user: { id: 'user-1', email: 'soc@acme.example', name: 'Ada SOC' },
  tenant: { id: TENANT_ID, slug: 'acme' },
  roles,
});

describe('resolvePortalAccess', () => {
  it('gives a logged-in soc seat the portal, with its tenant, through normal auth', () => {
    expect(resolvePortalAccess({ session: session(['soc']), linkClaims: null })).toEqual({
      kind: 'seat',
      tenantSlug: 'acme',
      userName: 'Ada SOC',
    });
  });

  it('gives a live link session the portal', () => {
    expect(resolvePortalAccess({ session: null, linkClaims: claims })).toEqual({
      kind: 'link',
      claims,
    });
  });

  it('prefers the seat when both a seat and a link session are present', () => {
    expect(resolvePortalAccess({ session: session(['soc']), linkClaims: claims }).kind).toBe(
      'seat',
    );
  });

  it('gives no portal to a console user without the soc role and no link', () => {
    expect(
      resolvePortalAccess({ session: session(['admin', 'viewer']), linkClaims: null }),
    ).toEqual({
      kind: 'none',
    });
  });

  it('does not treat a role named like the soc role in another case as the seat role', () => {
    expect(resolvePortalAccess({ session: session(['SOC']), linkClaims: null }).kind).toBe('none');
  });

  it('gives nothing to an anonymous visitor with no link session', () => {
    expect(resolvePortalAccess({ session: null, linkClaims: null })).toEqual({ kind: 'none' });
  });
});
