// The SOC portal without a Blackwing account (SOCUI-001, #553): a visitor with no link and no seat is sent to
// the expired page, and a forged link never opens the portal. Signed-link and `soc` seat flows need the
// portal key pair in the dev stack (BW_SOC_* variables), so they run once the notice issuer lands (NOTIFY).

import { expect, test } from '@playwright/test';

import { loadE2eSettings } from '../../support/env.js';

const settings = loadE2eSettings();

test.describe('SOC portal, unauthenticated', () => {
  test('sends a visitor with no link and no seat to the expired page', async ({ page }) => {
    await page.goto(new URL('/portal', settings.webUrl).href);

    await expect(page).toHaveURL(/\/portal\/expired$/);
    await expect(page.getByRole('heading', { name: 'This link is no longer valid' })).toBeVisible();
    await expect(page.getByText(/stack trace|Error:/i)).toHaveCount(0);
  });

  test('refuses a forged link with the same expired page and no portal', async ({ page }) => {
    await page.goto(new URL('/link/not.a-valid-link', settings.webUrl).href);

    await expect(page).toHaveURL(/\/portal\/expired$/);
    await expect(page.getByRole('heading', { name: 'This link is no longer valid' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'SOC portal' })).toHaveCount(0);
  });
});
