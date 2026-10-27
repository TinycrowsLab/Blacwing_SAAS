import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  defineIntegrationConfig,
  defineUnitConfig,
  INTEGRATION_HOOK_TIMEOUT_MS,
  INTEGRATION_TEST_GLOB,
  INTEGRATION_TEST_TIMEOUT_MS,
  UNIT_TEST_GLOB,
} from './config.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>;
  exports: Record<string, string>;
};

describe('defineUnitConfig', () => {
  const config = defineUnitConfig();

  it('runs *.test.ts but never integration files (unit runs never need Docker)', () => {
    expect(config.test?.include).toEqual([UNIT_TEST_GLOB]);
    expect(config.test?.exclude).toContain(INTEGRATION_TEST_GLOB);
  });

  it('pins the time zone to UTC and restores mocks and stubs', () => {
    expect(config.test?.env).toEqual({ TZ: 'UTC' });
    expect(config.test?.restoreMocks).toBe(true);
    expect(config.test?.unstubEnvs).toBe(true);
  });

  it('merges member overrides', () => {
    const merged = defineUnitConfig({ test: { testTimeout: 1234 } });
    expect(merged.test?.testTimeout).toBe(1234);
    expect(merged.test?.include).toEqual([UNIT_TEST_GLOB]);
  });
});

describe('defineIntegrationConfig', () => {
  const config = defineIntegrationConfig();

  it('runs only *.int.test.ts with container-sized timeouts and no retries', () => {
    expect(config.test?.include).toEqual([INTEGRATION_TEST_GLOB]);
    expect(config.test?.testTimeout).toBe(INTEGRATION_TEST_TIMEOUT_MS);
    expect(config.test?.hookTimeout).toBe(INTEGRATION_HOOK_TIMEOUT_MS);
    expect(config.test?.retry).toBe(0);
    expect(config.test?.pool).toBe('forks');
  });
});

describe('package wiring', () => {
  it('exposes test:int through the integration config', () => {
    expect(manifest.scripts.test).toBe('vitest run --config src/vitest.config.ts');
    expect(manifest.scripts['test:int']).toBe('vitest run --config src/vitest.int.config.ts');
  });

  it('keeps Docker-free helpers, containers, Vitest wiring and presets on separate entry points', () => {
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './containers',
      './temporal',
      './vitest',
      './vitest-config',
      './ci-preload',
      './sql/*',
    ]);
  });
});
