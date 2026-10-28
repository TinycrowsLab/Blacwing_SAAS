import { defineConfig } from 'vitest/config';

// Unit tests only: `*.int.test.ts` needs the dev stack (`pnpm test:int`); `*.chaos.test.ts` is the timed SLO suite (`pnpm test:chaos`).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.int.test.ts', 'src/**/*.chaos.test.ts'],
  },
});
