import { defineUnitConfig } from '@blackwing/testing/vitest-config';

// apps/web keeps `jsx: preserve` for Next.js; Vitest has to compile JSX itself and also runs
// component tests (*.test.tsx).
export default defineUnitConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});
