import { defineConfig } from 'vitest/config';

// Kill SLO chaos suite (KILL-008, #184). Real timers: timing assertions must never auto-retry, so `retry`
// is pinned to 0 and the files run one at a time. Run by `pnpm --filter @blackwing/worker test:chaos`.
export default defineConfig({
  test: {
    include: ['src/**/*.chaos.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    env: { TZ: 'UTC' },
    retry: 0,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
