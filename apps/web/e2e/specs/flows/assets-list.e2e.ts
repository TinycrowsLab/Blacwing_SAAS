// The asset inventory (`/assets`, #368): without a session the list is never served and the browser lands on /login.
// The signed-in flows (list, filter, create) need the dev stack and a seeded session; they run in the dev e2e pass
// once IAM issues dev sessions (see console-shell.e2e.ts). This spec keeps the unauthenticated guard under test.

import { expect, test } from '@playwright/test';

import { loadE2eSettings } from '../../support/env.js';

const settings = loadE2eSettings();

test.describe('asset inventory', () => {
  test('redirects /assets to /login without a session and serves no list markup', async ({
    page,
  }) => {
    await page.goto(new URL('/assets?environment=prod', settings.webUrl).href);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Blackwing' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Assets' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Register asset' })).toHaveCount(0);
  });
});
