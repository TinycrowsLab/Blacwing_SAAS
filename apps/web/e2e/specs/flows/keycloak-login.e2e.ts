// Authenticated browser flow against the dev identity provider (CI-006, #140): a seeded Keycloak test
// user of tenant `acme` signs in to the realm account console and signs out again; a wrong password is
// refused. Password login exists only in dev/test (BW_DEV_PASSWORD_LOGIN_ENABLED). The password comes
// from the untracked `.env` and is never logged or asserted on.

import { expect, test, type Page } from '@playwright/test';

import { loadE2eSettings, requireTestPassword } from '../../support/env.js';

const settings = loadE2eSettings();
const accountUrl = new URL(`/realms/${settings.realm}/account/`, settings.keycloakUrl).href;

async function submitLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto(accountUrl);
  await expect(page.locator('#kc-form-login')).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

test.describe('dev identity provider', () => {
  test('a seeded user signs in and out', async ({ page }) => {
    await submitLogin(page, settings.testUser, requireTestPassword(settings));

    await expect(page).toHaveURL(new RegExp(`/realms/${settings.realm}/account`));
    await expect(page.locator('#kc-form-login')).toHaveCount(0);
    // An SSO session now exists for the realm (cookie names only; values are never read).
    const cookies = await page.context().cookies(accountUrl);
    expect(cookies.map((c) => c.name)).toContain('KEYCLOAK_IDENTITY');
    await page.goto(accountUrl);
    await expect(page.locator('#kc-form-login')).toHaveCount(0);

    const logoutUrl = new URL(
      `/realms/${settings.realm}/protocol/openid-connect/logout`,
      settings.keycloakUrl,
    ).href;
    await page.goto(logoutUrl);
    const confirm = page.locator('#kc-logout');
    if ((await confirm.count()) > 0) await confirm.click();
    await page.goto(accountUrl);
    await expect(page.locator('#kc-form-login')).toBeVisible();
  });

  test('a wrong password is refused', async ({ page }) => {
    await submitLogin(page, settings.testUser, 'not-the-dev-password');

    await expect(page.locator('#kc-form-login')).toBeVisible();
    await expect(
      page.locator('#input-error, .kc-feedback-text, [id*="error"]').first(),
    ).toBeVisible();
  });
});
