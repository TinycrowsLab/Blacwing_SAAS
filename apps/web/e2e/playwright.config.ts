// Playwright e2e suite (CI-006, #140): `pnpm test:e2e` against the dev compose stack and the local
// Juice Shop lab target. Headless Chromium only, UTC clock, one worker in CI.
//
// Retries are scoped: only the `navigation` project (page loads of the lab target, which can flake on a
// cold container) retries once and records a trace on that first retry. `flows` never retries, so a
// flaky flow is a real failure, and keeps its trace on failure instead. Videos and screenshots are kept
// for failures only; the workflow uploads playwright-report/ and test-results/ when the job fails.

import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

const ci = process.env.CI === 'true';
const NAVIGATION = /navigation\/.+\.e2e\.ts$/;

const reporters: ReporterDescription[] = [
  ['list'],
  ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ['json', { outputFile: '../test-results/results.json' }],
];
if (ci) reporters.push(['github']);

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.e2e.ts',
  outputDir: '../test-results/artifacts',
  forbidOnly: true,
  fullyParallel: false,
  workers: ci ? 1 : 2,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: reporters,
  use: {
    headless: true,
    timezoneId: 'UTC',
    locale: 'en-US',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // The lab target and Keycloak are plain http on loopback (documented CI variant, docs/runbooks/e2e.md).
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: 'navigation',
      testMatch: NAVIGATION,
      retries: 1,
      use: { ...devices['Desktop Chrome'], browserName: 'chromium', trace: 'on-first-retry' },
    },
    {
      name: 'flows',
      testIgnore: NAVIGATION,
      retries: 0,
      use: { ...devices['Desktop Chrome'], browserName: 'chromium' },
    },
  ],
});
