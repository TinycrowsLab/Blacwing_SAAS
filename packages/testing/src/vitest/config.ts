/**
 * Shared Vitest presets (CONTEXT_PACK §5: Vitest for unit tests, Testcontainers for integration).
 *
 * Convention: unit tests are `src/**\/*.test.ts` and never need Docker; integration tests are
 * `src/**\/*.int.test.ts` and run only under `pnpm test:int`. A member opts in with two files
 * under `src/` (so the member's tsconfig typechecks and lints them) and two scripts:
 *
 *   // src/vitest.config.ts   ("test": "vitest run --config src/vitest.config.ts")
 *   import { defineUnitConfig } from "@blackwing/testing/vitest-config";
 *   export default defineUnitConfig();
 *
 *   // src/vitest.int.config.ts   ("test:int": "vitest run --config src/vitest.int.config.ts")
 *   import { defineIntegrationConfig } from "@blackwing/testing/vitest-config";
 *   export default defineIntegrationConfig();
 *
 * This module runs at config-load time, so it must not import the Vitest runtime (`vi`, hooks).
 */
import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';

/** Unit test files. */
export const UNIT_TEST_GLOB = 'src/**/*.test.ts';
/** Integration test files (Testcontainers). */
export const INTEGRATION_TEST_GLOB = 'src/**/*.int.test.ts';

const ALWAYS_EXCLUDED = ['**/node_modules/**', '**/dist/**'];

/** Integration tests start containers: bound the per-test and per-hook budgets generously. */
export const INTEGRATION_TEST_TIMEOUT_MS = 120_000;
export const INTEGRATION_HOOK_TIMEOUT_MS = 300_000;
/** Each integration file may start several containers; keep concurrency low on dev hosts and CI runners. */
export const INTEGRATION_MAX_WORKERS = 2;

const shared = {
  environment: 'node',
  // Never depend on the host time zone (§5: ISO-8601 UTC everywhere).
  env: { TZ: 'UTC' },
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
} as const;

/** Vitest config for unit tests: excludes integration files, UTC time zone, mocks restored between tests. */
export function defineUnitConfig(overrides: ViteUserConfig = {}): ViteUserConfig {
  return mergeConfig(
    defineConfig({
      test: {
        ...shared,
        include: [UNIT_TEST_GLOB],
        exclude: [...ALWAYS_EXCLUDED, INTEGRATION_TEST_GLOB],
      },
    }),
    overrides,
  );
}

/** Vitest config for integration tests: only `*.int.test.ts`, long timeouts, bounded parallelism, no retries. */
export function defineIntegrationConfig(overrides: ViteUserConfig = {}): ViteUserConfig {
  return mergeConfig(
    defineConfig({
      test: {
        ...shared,
        include: [INTEGRATION_TEST_GLOB],
        exclude: ALWAYS_EXCLUDED,
        testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
        hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
        // Containers are torn down in afterAll; give them time even when a test failed.
        teardownTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
        pool: 'forks',
        maxWorkers: INTEGRATION_MAX_WORKERS,
        minWorkers: 1,
        // Retries would hide flaky isolation bugs; container boot has its own wait-for-ready timeout.
        retry: 0,
      },
    }),
    overrides,
  );
}
