import { defineConfig } from 'vitest/config';

// Integration tests against the dev stack (`pnpm dev:deps`): the Temporal smoke test needs `temporal`
// and `temporal-bootstrap` up.
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
