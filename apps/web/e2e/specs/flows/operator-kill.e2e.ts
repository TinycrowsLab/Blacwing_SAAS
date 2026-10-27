// The operator kill control (/operator/kill): like every protected route it sends a visitor without a
// session to /login before any markup is served. The full preview -> confirm -> fire -> halt-time flow
// needs an operator session, which arrives with platform-operator authentication (#838); until then it is
// covered by the Vitest panel tests and the API route tests against a simulated kill.

import { expect, test } from '@playwright/test';

import { loadE2eSettings } from '../../support/env.js';

const settings = loadE2eSettings();

test.describe('operator kill control', () => {
  test('redirects to /login without a session and serves no operator markup', async ({ page }) => {
    await page.goto(new URL('/operator/kill', settings.webUrl).href);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('operator-shell')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /fire kill/i })).toHaveCount(0);
  });
});
