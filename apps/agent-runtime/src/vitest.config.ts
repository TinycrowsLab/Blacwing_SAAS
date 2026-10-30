import { defineConfig } from 'vitest/config';

// Unit tests only: `*.int.test.ts` launches real Chromium and runs under `pnpm test:int` (vitest.int.config.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.int.test.ts'],
  },
});
