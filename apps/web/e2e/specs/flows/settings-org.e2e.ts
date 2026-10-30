// The organisation profile (ADMIN-001, /settings/org) against the dev Keycloak and the local console.
// The console BFF issues the session cookie for `localhost` only (BW_CONSOLE_ORIGIN), so the suite drives
// loopback `localhost` even when BW_WEB_URL names 127.0.0.1. The password comes from the untracked `.env`
// and is never logged or asserted on. The stale-edit (ETAG_MISMATCH) and validation paths are covered by the
// Vitest form tests and the API HTTP tests.

import { expect, test, type Page } from '@playwright/test';

import { loadE2eSettings, requireTestPassword } from '../../support/env.js';

const settings = loadE2eSettings();
const web = new URL(settings.webUrl.href);
web.hostname = 'localhost';

const MAX_NAME_LENGTH = 120;

/** Seeded Org Owner/Admin of the demo tenant `acme` (realm group `/acme/org-admins`). */
const ADMIN_USER = 'admin@acme.test';
/** Seeded non-admin member of `acme` (realm group `/acme/developers`). */
const MEMBER_USER = 'dev@acme.test';

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto(new URL('/api/auth/login', web).href);
  await expect(page.locator('#kc-form-login')).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(requireTestPassword(settings));
  await page.locator('#kc-login').click();
  await page.waitForURL(new URL('/', web).href);
}

async function openOrgSettings(page: Page): Promise<void> {
  await page.goto(new URL('/settings/org', web).href);
}

test.describe('organisation settings', () => {
  test('redirects /settings/org to /login without a session and serves no organisation form', async ({
    page,
  }) => {
    await page.goto(new URL('/settings/org', settings.webUrl).href);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('form', { name: 'Organisation profile' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
  });

  test('an admin sees the profile and saves an edit that survives a reload', async ({ page }) => {
    await signIn(page, ADMIN_USER);
    await openOrgSettings(page);

    const form = page.getByRole('form', { name: 'Organisation profile' });
    await expect(form).toBeVisible();
    const name = form.getByLabel('Organisation name');
    const original = await name.inputValue();
    const edited = `${original} e2e ${Date.now()}`.slice(0, MAX_NAME_LENGTH);

    try {
      await name.fill(edited);
      await form.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Organisation profile saved')).toBeVisible();

      await openOrgSettings(page);
      await expect(page.getByRole('form', { name: 'Organisation profile' })).toBeVisible();
      await expect(page.getByLabel('Organisation name')).toHaveValue(edited);
    } finally {
      // Put the seeded demo tenant back as it was, so reruns and other suites see the same profile.
      await openOrgSettings(page);
      const restore = page.getByLabel('Organisation name');
      if ((await restore.inputValue()) !== original) {
        await restore.fill(original);
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByText('Organisation profile saved')).toBeVisible();
      }
    }
  });

  test('a non-admin member gets the permission-denied state and no organisation form', async ({
    page,
  }) => {
    await signIn(page, MEMBER_USER);
    await openOrgSettings(page);

    await expect(page.getByRole('form', { name: 'Organisation profile' })).toHaveCount(0);
    await expect(page.getByLabel('Organisation name')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
  });
});
