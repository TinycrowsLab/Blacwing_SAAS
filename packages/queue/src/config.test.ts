import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BULL_PREFIX,
  DEFAULT_REDIS_URL,
  DEFAULT_WORKER_CONCURRENCY,
  parseBullConfig,
} from './config.js';

describe('parseBullConfig', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(parseBullConfig({})).toEqual({
      redisUrl: DEFAULT_REDIS_URL,
      prefix: DEFAULT_BULL_PREFIX,
      workerConcurrency: DEFAULT_WORKER_CONCURRENCY,
    });
    expect(DEFAULT_REDIS_URL).toBe('redis://valkey:6379');
    expect(DEFAULT_BULL_PREFIX).toBe('bw');
    expect(DEFAULT_WORKER_CONCURRENCY).toBe(10);
  });

  it('reads REDIS_URL, BULL_PREFIX and BULL_WORKER_CONCURRENCY', () => {
    expect(
      parseBullConfig({
        REDIS_URL: 'rediss://:pw@valkey.internal:6380',
        BULL_PREFIX: 'bwtest',
        BULL_WORKER_CONCURRENCY: '32',
      }),
    ).toEqual({
      redisUrl: 'rediss://:pw@valkey.internal:6380',
      prefix: 'bwtest',
      workerConcurrency: 32,
    });
  });

  it('rejects a non-Redis URL, a bad prefix and an out-of-range concurrency (fail fast)', () => {
    expect(() => parseBullConfig({ REDIS_URL: 'http://valkey:6379' })).toThrow();
    expect(() => parseBullConfig({ BULL_PREFIX: 'bw:evil' })).toThrow();
    expect(() => parseBullConfig({ BULL_PREFIX: 'BW' })).toThrow();
    expect(() => parseBullConfig({ BULL_WORKER_CONCURRENCY: '0' })).toThrow();
    expect(() => parseBullConfig({ BULL_WORKER_CONCURRENCY: '257' })).toThrow();
    expect(() => parseBullConfig({ BULL_WORKER_CONCURRENCY: 'ten' })).toThrow();
  });
});
