// The console shell (CONSOLE-001, #261): every (console) route is guarded by a server-side session
// check. Without a valid session the browser lands on /login; no protected markup is served first.
// The seeded-session render is covered by the Vitest layout tests until IAM's BFF issues dev sessions.

import { expect, test } from '@playwright/test';

import { loadE2eSettings } from '../../support/env.js';

const settings = loadE2eSettings();

test.describe('console shell', () => {
  test('redirects to /login without a session', async ({ page }) => {
    await page.goto(settings.webUrl.href);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Blackwing' })).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
  });

  test('treats a garbage session cookie as absent, without a stack trace', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: '__Host-bw_session',
        value: 'not-a-session',
        url: settings.webUrl.href,
        secure: true,
        httpOnly: true,
      },
    ]);
    await page.goto(new URL('/', settings.webUrl).href);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(/at \S+ \(/)).toHaveCount(0);
  });
});
