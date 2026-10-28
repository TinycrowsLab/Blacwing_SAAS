// The platform-operator BFF route handlers end to end over the real operator service, an in-memory Valkey and a
// fake operator IdP (#838). Only the process-wide wiring (`runtime`) is replaced.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as callback } from './callback/route';
import { GET as login } from './login/route';
import { POST as logout } from './logout/route';
import { POST as refresh } from './refresh/route';
import { GET as sessionRoute } from './session/route';
import { Clock, CONSOLE_ORIGIN } from '../../../../../lib/auth/auth.test-helpers';
import { CSRF_HEADER } from '../../../../../lib/auth/http';
import {
  operatorHarness,
  operatorTokens,
  type OperatorHarness,
} from '../../../../../lib/operator-auth/operator.test-helpers';

const state: { h: OperatorHarness } = { h: operatorHarness(new Clock()) };

vi.mock('../../../../../lib/operator-auth/runtime', () => ({
  getOperatorAuthRuntime: () => ({
    config: {
      issuer: 'https://id.example.com/realms/blackwing-operators',
      clientId: 'operator-bff',
      clientSecret: 'client-secret',
      consoleOrigin: CONSOLE_ORIGIN,
      redirectUri: `${CONSOLE_ORIGIN}/operator/api/auth/callback`,
      redisUrl: 'redis://unused',
      sessionKeys: state.h.keys,
    },
    service: state.h.service,
  }),
}));

beforeEach(() => {
  state.h = operatorHarness(new Clock());
});

const API = `${CONSOLE_ORIGIN}/operator/api/auth`;

/** The value of a cookie the response sets, or undefined. */
function setCookieOf(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

/** Signs an operator in through the real routes; returns the operator session cookie value. */
async function signIn(): Promise<string> {
  state.h.oidc.exchangeCode.mockResolvedValueOnce(operatorTokens());
  const start = await login(new Request(`${API}/login?returnTo=/operator/kill`));
  const location = start.headers.get('location') ?? '';
  const loginCookie = setCookieOf(start, '__Host-bw_op_login')?.split(';')[0]?.split('=')[1] ?? '';
  const oidcState = new URL(location).searchParams.get('state') ?? '';
  const done = await callback(
    new Request(`${API}/callback?code=c&state=${oidcState}`, {
      headers: { cookie: `__Host-bw_op_login=${loginCookie}` },
    }),
  );
  const cookie = setCookieOf(done, '__Host-bw_op_session')?.split(';')[0]?.split('=')[1];
  if (cookie === undefined) throw new Error('no operator session cookie');
  return cookie;
}

const sessionHeaders = (cookie: string, extra: Record<string, string> = {}) => ({
  cookie: `__Host-bw_op_session=${cookie}`,
  origin: CONSOLE_ORIGIN,
  ...extra,
});

describe('operator BFF routes (#838)', () => {
  it('starts the operator flow with a Secure, HttpOnly, SameSite=Lax login cookie under its own name', async () => {
    const response = await login(new Request(`${API}/login`));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('code_challenge_method=S256');
    const cookie = setCookieOf(response, '__Host-bw_op_login') ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
  });

  it('sets the operator session cookie on success and never a tenant cookie', async () => {
    const cookie = await signIn();
    expect(cookie.length).toBeGreaterThan(0);
    const response = await sessionRoute(
      new Request(`${API}/session`, { headers: sessionHeaders(cookie) }),
    );
    expect(response.status).toBe(200);
  });

  it('answers the session route with identity, roles, csrf and expiry, and never a token', async () => {
    const cookie = await signIn();
    const response = await sessionRoute(
      new Request(`${API}/session`, { headers: sessionHeaders(cookie) }),
    );
    const body = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(body)).toMatchObject({
      operator: { id: 'op-0001' },
      roles: ['platform_operator'],
    });
    expect(body).not.toContain('operator-access-1');
    expect(body).not.toContain('operator-refresh-1');
  });

  it('fails the callback with the reason and creates no session for a bad state', async () => {
    const start = await login(new Request(`${API}/login`));
    const loginCookie =
      setCookieOf(start, '__Host-bw_op_login')?.split(';')[0]?.split('=')[1] ?? '';
    const response = await callback(
      new Request(`${API}/callback?code=c&state=forged`, {
        headers: { cookie: `__Host-bw_op_login=${loginCookie}` },
      }),
    );
    expect(response.headers.get('location')).toBe(`${CONSOLE_ORIGIN}/login?error=invalid_state`);
    expect(setCookieOf(response, '__Host-bw_op_session')).toBeUndefined();
  });

  it('refuses a sign-in without the second factor: the reason is shown and no session cookie is set', async () => {
    state.h.oidc.exchangeCode.mockResolvedValueOnce(
      operatorTokens({ claims: { sub: 'op-0001', acr: 'password', roles: ['platform_operator'] } }),
    );
    const start = await login(new Request(`${API}/login`));
    const loginCookie =
      setCookieOf(start, '__Host-bw_op_login')?.split(';')[0]?.split('=')[1] ?? '';
    const oidcState = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const response = await callback(
      new Request(`${API}/callback?code=c&state=${oidcState}`, {
        headers: { cookie: `__Host-bw_op_login=${loginCookie}` },
      }),
    );
    expect(response.headers.get('location')).toBe(`${CONSOLE_ORIGIN}/login?error=mfa_required`);
    expect(setCookieOf(response, '__Host-bw_op_session')).toBeUndefined();
  });

  it('answers the session route 401 with no cookie, and ignores a tenant session cookie', async () => {
    const none = await sessionRoute(new Request(`${API}/session`));
    expect(none.status).toBe(401);
    const tenant = await sessionRoute(
      new Request(`${API}/session`, { headers: { cookie: '__Host-bw_session=tenant-cookie' } }),
    );
    expect(tenant.status).toBe(401);
    expect(setCookieOf(tenant, '__Host-bw_op_session')).toBeUndefined();
  });

  it('requires the CSRF secret to log out, and logs out with it', async () => {
    const cookie = await signIn();
    const noCsrf = await logout(
      new Request(`${API}/logout`, { method: 'POST', headers: sessionHeaders(cookie) }),
    );
    expect(noCsrf.status).toBe(403);

    const session = await sessionRoute(
      new Request(`${API}/session`, { headers: sessionHeaders(cookie) }),
    );
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const out = await logout(
      new Request(`${API}/logout`, {
        method: 'POST',
        headers: sessionHeaders(cookie, { [CSRF_HEADER]: csrfToken }),
      }),
    );
    expect(out.status).toBe(200);
    expect(setCookieOf(out, '__Host-bw_op_session')).toMatch(/Max-Age=0/);
    expect(state.h.audit.at(-1)).toMatchObject({ action: 'auth.operator_logout' });
  });

  it('requires the CSRF secret to renew, and renews with it', async () => {
    const cookie = await signIn();
    const noCsrf = await refresh(
      new Request(`${API}/refresh`, { method: 'POST', headers: sessionHeaders(cookie) }),
    );
    expect(noCsrf.status).toBe(403);
    const session = await sessionRoute(
      new Request(`${API}/session`, { headers: sessionHeaders(cookie) }),
    );
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const ok = await refresh(
      new Request(`${API}/refresh`, {
        method: 'POST',
        headers: sessionHeaders(cookie, { [CSRF_HEADER]: csrfToken }),
      }),
    );
    expect(ok.status).toBe(200);
  });
});
