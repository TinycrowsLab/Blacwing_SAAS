// The local Juice Shop lab target (seeded demo asset) loads in headless Chromium (CI-006, #140).
// Benign oracle only: page load and app metadata, never an exploit or a state-changing request.

import { expect, test } from '@playwright/test';

import { loadE2eSettings } from '../../support/env.js';

const settings = loadE2eSettings();
const HTTP_OK_MAX = 399;

test.describe('Juice Shop lab target', () => {
  test('serves the storefront on loopback', async ({ page }) => {
    const response = await page.goto(settings.targetUrl.href, { waitUntil: 'domcontentloaded' });

    expect(response, 'navigation produced a response').not.toBeNull();
    expect(response?.status() ?? 0).toBeLessThanOrEqual(HTTP_OK_MAX);
    expect(new URL(page.url()).hostname).toBe(settings.targetUrl.hostname);
    await expect(page).toHaveTitle(/OWASP Juice Shop/);
    await expect(page.getByRole('heading', { name: /Welcome to OWASP Juice Shop/ })).toBeVisible();
  });

  test('answers its read-only version endpoint', async ({ request }) => {
    const response = await request.get(
      new URL('/rest/admin/application-version', settings.targetUrl).href,
    );

    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { version?: unknown };
    expect(typeof body.version).toBe('string');
  });
});
