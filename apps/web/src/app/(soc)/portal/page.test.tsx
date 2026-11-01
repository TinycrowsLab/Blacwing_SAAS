// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sealPortalSession } from '../../../lib/soc-portal/session';
import {
  ASSET_ID,
  JTI,
  NOW_SECONDS,
  OTHER_ASSET_ID,
  portalConfig,
  TENANT_ID,
} from '../../../lib/soc-portal/test-helpers';
import { socPortalClaimsSchema } from '../../../lib/soc-portal/token';

import type { Session } from '../../../lib/session';
import type { SocPortalConfig } from '../../../lib/soc-portal/config';

const state = vi.hoisted(() => ({
  session: null as null | Session,
  outage: false,
  cookies: new Map<string, string>(),
  config: undefined as SocPortalConfig | undefined,
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = state.cookies.get(name);
        return value === undefined ? undefined : { value };
      },
    }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock('../../../lib/session', () => {
  class SessionUnavailableError extends Error {}
  return {
    SessionUnavailableError,
    getSession: () =>
      state.outage ? Promise.reject(new SessionUnavailableError()) : Promise.resolve(state.session),
  };
});
vi.mock('../../../lib/soc-portal/runtime', () => ({ getSocPortalConfig: () => state.config }));

const { default: SocPortalPage } = await import('./page');

const EXP = NOW_SECONDS + 3600;

function linkCookieFor(assetIds: string[], exp = EXP): string {
  const config = portalConfig();
  const claims = socPortalClaimsSchema.parse({
    tenantId: TENANT_ID,
    scope: 'soc_portal',
    assetIds,
    jti: JTI,
    exp,
  });
  const setCookie = sealPortalSession(config.sessionKey, claims, NOW_SECONDS);
  return /^__Host-bw_soc_portal=([^;]+);/.exec(setCookie)?.[1] ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_SECONDS * 1000, toFake: ['Date'] });
  state.session = null;
  state.outage = false;
  state.cookies.clear();
  state.config = portalConfig();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const page = async () => render(await SocPortalPage());

describe('SOC portal page', () => {
  it('shows a live link session its scope and expiry, read-only', async () => {
    state.cookies.set('__Host-bw_soc_portal', linkCookieFor([ASSET_ID]));
    await page();
    expect(screen.getByRole('heading').textContent).toBe('SOC portal');
    expect(screen.getByText('1 system is in scope for this link. Read-only view.')).toBeTruthy();
    expect(screen.getByText(new Date(EXP * 1000).toISOString())).toBeTruthy();
  });

  it('counts several systems in the link scope', async () => {
    state.cookies.set('__Host-bw_soc_portal', linkCookieFor([ASSET_ID, OTHER_ASSET_ID]));
    await page();
    expect(screen.getByText(/2 systems are in scope/)).toBeTruthy();
  });

  it('shows a logged-in soc seat the same portal, with its tenant', async () => {
    state.session = {
      user: { id: 'u1', email: 'soc@acme.example', name: 'Ada SOC' },
      tenant: { id: TENANT_ID, slug: 'acme' },
      roles: ['soc'],
    };
    await page();
    expect(screen.getByText('Signed in as Ada SOC for acme. Read-only view.')).toBeTruthy();
  });

  it('sends a console user without the soc role and no link to the expired page', async () => {
    state.session = {
      user: { id: 'u2', email: 'dev@acme.example', name: 'Dev' },
      tenant: { id: TENANT_ID, slug: 'acme' },
      roles: ['developer'],
    };
    await expect(SocPortalPage()).rejects.toThrow('NEXT_REDIRECT:/portal/expired');
  });

  it('sends a visitor with an expired link session to the expired page', async () => {
    state.cookies.set('__Host-bw_soc_portal', linkCookieFor([ASSET_ID], NOW_SECONDS - 3600 * 2));
    await expect(SocPortalPage()).rejects.toThrow('NEXT_REDIRECT:/portal/expired');
  });

  it('sends an anonymous visitor with no cookie to the expired page', async () => {
    await expect(SocPortalPage()).rejects.toThrow('NEXT_REDIRECT:/portal/expired');
  });

  it('refuses a portal cookie while the portal is disabled', async () => {
    state.cookies.set('__Host-bw_soc_portal', linkCookieFor([ASSET_ID]));
    state.config = undefined;
    await expect(SocPortalPage()).rejects.toThrow('NEXT_REDIRECT:/portal/expired');
  });

  it('says the portal is unavailable, rather than signing anyone out, during a session outage', async () => {
    state.outage = true;
    await page();
    expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable');
  });
});
