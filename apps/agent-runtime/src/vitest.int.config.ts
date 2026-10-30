import { defineConfig } from 'vitest/config';

// Integration tests: real headless Chromium through a fake gateway (BROWSER-001). Needs the pinned Playwright browsers.
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
