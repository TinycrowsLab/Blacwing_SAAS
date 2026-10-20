import { defineConfig } from 'vitest/config';

// Unit tests only: `*.int.test.ts` needs the dev stack and runs under `pnpm test:int`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.int.test.ts'],
  },
});
