// The console BFF sign-in against the dev Keycloak (IAM-002, #334): Authorization Code + PKCE login,
// whoami, refresh, logout and the negative paths. The console runs with BW_CONSOLE_ORIGIN
// http://localhost:3000, which is the origin the dev realm registers for the BFF client, so the suite
// drives `localhost` (loopback) even when BW_WEB_URL names 127.0.0.1. The password comes from the
// untracked `.env` and is never logged or asserted on.

import { expect, test, type Page } from '@playwright/test';

import { loadE2eSettings, requireTestPassword } from '../../support/env.js';

const settings = loadE2eSettings();
const web = new URL(settings.webUrl.href);
web.hostname = 'localhost';

const SESSION_COOKIE = '__Host-bw_session';
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

async function signIn(page: Page): Promise<void> {
  await page.goto(new URL('/api/auth/login', web).href);
  await expect(page.locator('#kc-form-login')).toBeVisible();
  await page.locator('#username').fill(settings.testUser);
  await page.locator('#password').fill(requireTestPassword(settings));
  await page.locator('#kc-login').click();
  await page.waitForURL(new URL('/', web).href);
}

async function whoami(page: Page): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await page.request.get(new URL('/api/auth/session', web).href);
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

test.describe('console BFF sign-in', () => {
  test('signs in, keeps tokens away from the browser, refreshes and signs out', async ({
    page,
    context,
  }) => {
    await signIn(page);

    const cookie = (await context.cookies(web.href)).find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.domain).toBe('localhost');

    // No script can read the session cookie, and nothing token-shaped sits in any client store.
    expect(await page.evaluate<string>('document.cookie')).not.toContain('bw_session');
    const storage = JSON.stringify((await context.storageState()).origins);
    const sessionStore = await page.evaluate<string>('JSON.stringify(sessionStorage)');
    for (const store of [storage, sessionStore, await page.content()]) {
      expect(store).not.toMatch(JWT);
    }
    for (const c of await context.cookies()) expect(c.value).not.toMatch(JWT);

    const session = await whoami(page);
    expect(session.status).toBe(HTTP_OK);
    expect(JSON.stringify(session.body)).not.toMatch(JWT);
    const csrf = String(session.body.csrfToken);

    const forged = await page.request.post(new URL('/api/auth/refresh', web).href);
    expect(forged.status()).toBe(HTTP_FORBIDDEN);
    const refreshed = await page.request.post(new URL('/api/auth/refresh', web).href, {
      headers: { 'x-bw-csrf': csrf },
    });
    expect(refreshed.status()).toBe(HTTP_OK);

    const logout = await page.request.post(new URL('/api/auth/logout', web).href, {
      headers: { 'x-bw-csrf': csrf },
    });
    expect(logout.status()).toBe(HTTP_OK);
    const { redirectTo } = (await logout.json()) as { redirectTo: string };
    expect(new URL(redirectTo).origin).toBe(settings.keycloakUrl.origin);
    expect((await whoami(page)).status).toBe(HTTP_UNAUTHORIZED);

    // The Keycloak session ended too: the next login asks for credentials again.
    await page.goto(redirectTo);
    const confirm = page.locator('#kc-logout');
    if ((await confirm.count()) > 0) await confirm.click();
    await page.goto(new URL('/api/auth/login', web).href);
    await expect(page.locator('#kc-form-login')).toBeVisible();
  });

  test('rejects a callback whose state does not match', async ({ page }) => {
    await page.goto(new URL('/api/auth/login', web).href);
    await expect(page.locator('#kc-form-login')).toBeVisible();
    await page.goto(new URL('/auth/callback?code=forged&state=forged', web).href);

    await expect(page).toHaveURL(/\/login\?error=invalid_state$/);
    await expect(page.getByRole('alert')).toBeVisible();
    expect((await whoami(page)).status).toBe(HTTP_UNAUTHORIZED);
  });

  test('never sends the browser off site through returnTo', async ({ page }) => {
    await page.goto(new URL('/api/auth/login?returnTo=https://evil.example/x', web).href);
    await expect(page.locator('#kc-form-login')).toBeVisible();
    await page.locator('#username').fill(settings.testUser);
    await page.locator('#password').fill(requireTestPassword(settings));
    await page.locator('#kc-login').click();
    await page.waitForURL(new URL('/', web).href);
    expect(new URL(page.url()).origin).toBe(web.origin);
  });
});
