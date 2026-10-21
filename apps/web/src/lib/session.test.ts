import { describe, expect, it, vi } from 'vitest';

import {
  loadSession,
  SESSION_COOKIE,
  SESSION_ENDPOINT_PATH,
  SessionUnavailableError,
  type SessionDeps,
} from './session';

const ORIGIN = 'http://bff.test';
const COOKIE_VALUE = 'super-secret-cookie-value';
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;

const identity = {
  user: { id: 'u1', email: 'owner@acme.test', name: 'Owner' },
  tenant: { id: 't1', slug: 'acme' },
  roles: ['owner'],
};

function deps(
  respond: () => Response | Promise<Response>,
  cookie: string | null = COOKIE_VALUE,
): SessionDeps & { fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(respond);
  return {
    readCookie: () => Promise.resolve(cookie ?? undefined),
    fetch: fetchMock as unknown as typeof fetch,
    bffOrigin: ORIGIN,
  } as SessionDeps & { fetch: ReturnType<typeof vi.fn> };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('loadSession', () => {
  it('returns the public identity, tenant and roles', async () => {
    const d = deps(() => json(identity));
    await expect(loadSession(d)).resolves.toEqual(identity);
    const [url, init] = d.fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(new URL(SESSION_ENDPOINT_PATH, ORIGIN).href);
    expect(init.headers).toMatchObject({ cookie: `${SESSION_COOKIE}=${COOKIE_VALUE}` });
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('manual');
  });

  it('never returns token fields, even when the BFF sends them', async () => {
    const d = deps(() =>
      json({
        ...identity,
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'it',
        user: { ...identity.user, token: 'x' },
        tenant: { ...identity.tenant, secret: 'y' },
      }),
    );
    const session = await loadSession(d);
    expect(session).toEqual(identity);
    const serialized = JSON.stringify(session);
    for (const leaked of ['accessToken', 'refreshToken', 'idToken', 'token', 'secret', 'at"']) {
      expect(serialized).not.toContain(leaked);
    }
    expect(Object.keys(session ?? {}).sort()).toEqual(['roles', 'tenant', 'user']);
  });

  it('treats a missing or empty cookie as no session without calling the BFF', async () => {
    for (const cookie of [null, '']) {
      const d = deps(() => json(identity), cookie);
      await expect(loadSession(d)).resolves.toBeNull();
      expect(d.fetch).not.toHaveBeenCalled();
    }
  });

  it.each([HTTP_UNAUTHORIZED, HTTP_FORBIDDEN])(
    'treats an expired or invalid cookie (%i) as no session',
    async (status) => {
      await expect(loadSession(deps(() => json({ error: 'expired' }, status)))).resolves.toBeNull();
    },
  );

  it('treats a malformed body as no session', async () => {
    await expect(loadSession(deps(() => json({ user: {} })))).resolves.toBeNull();
    await expect(loadSession(deps(() => json(null)))).resolves.toBeNull();
    await expect(
      loadSession(deps(() => new Response('<html>', { status: 200 }))),
    ).resolves.toBeNull();
    await expect(loadSession(deps(() => json({ ...identity, roles: [1] })))).resolves.toBeNull();
  });

  it('throws SessionUnavailableError on a 5xx without leaking the cookie', async () => {
    const error = await loadSession(deps(() => json({}, HTTP_UNAVAILABLE))).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SessionUnavailableError);
    expect((error as Error).message).not.toContain(COOKIE_VALUE);
  });

  it('throws SessionUnavailableError when the BFF is unreachable, hiding the cause', async () => {
    const error = await loadSession(
      deps(() => Promise.reject(new Error(`connect ECONNREFUSED ${COOKIE_VALUE}`))),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionUnavailableError);
    expect(JSON.stringify(error)).not.toContain(COOKIE_VALUE);
    expect((error as Error).message).not.toContain(COOKIE_VALUE);
    expect((error as Error).cause).toBeUndefined();
  });
});
