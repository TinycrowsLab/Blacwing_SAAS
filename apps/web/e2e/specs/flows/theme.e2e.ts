// Theming (CONSOLE-003, #263): the root ThemeProvider applies `.dark` on <html> before hydration, keeps
// the persisted `bw-theme` choice and follows the OS preference live under `system`. The public /login
// page sits under the same provider, so these checks run without a session (the authenticated shell is
// covered once IAM's BFF issues dev sessions). The Light/Dark/System toggle lives in the shell and is
// covered by the Vitest suite in packages/ui.

import { expect, test } from '@playwright/test';

import { loadE2eSettings } from '../../support/env.js';

const settings = loadE2eSettings();
const loginUrl = new URL('/login', settings.webUrl).href;

test.describe('theme on the public login page', () => {
  test('server HTML carries the pre-hydration theme script (no first-paint flash)', async ({
    request,
  }) => {
    const response = await request.get(loginUrl);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('bw-theme');
    expect(html).toMatch(/<html[^>]*lang="en"/);
  });

  test('a persisted dark choice is applied on load and survives a reload', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('bw-theme', 'dark');
    });
    await page.goto(loginUrl);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });

  test.describe('system preference', () => {
    test.use({ colorScheme: 'dark' });

    test('follows the OS dark preference and tracks a live OS change', async ({ page }) => {
      await page.goto(loginUrl);
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);

      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    });
  });
});
