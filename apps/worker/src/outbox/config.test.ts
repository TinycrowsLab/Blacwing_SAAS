import { describe, expect, it } from 'vitest';

import { parseOutboxRelayConfig } from './config.js';

const base = { NODE_ENV: 'test' } as const;

describe('parseOutboxRelayConfig', () => {
  it('applies the documented defaults', () => {
    expect(parseOutboxRelayConfig(base)).toEqual({
      batchSize: 100,
      pollIntervalMs: 500,
      maxAttempts: 12,
    });
  });

  it('reads the three settings from the environment', () => {
    expect(
      parseOutboxRelayConfig({
        ...base,
        OUTBOX_BATCH_SIZE: '25',
        OUTBOX_POLL_INTERVAL_MS: '50',
        OUTBOX_MAX_ATTEMPTS: '3',
      }),
    ).toEqual({ batchSize: 25, pollIntervalMs: 50, maxAttempts: 3 });
  });

  it.each([
    ['OUTBOX_BATCH_SIZE', '0'],
    ['OUTBOX_BATCH_SIZE', '1001'],
    ['OUTBOX_BATCH_SIZE', 'ten'],
    ['OUTBOX_POLL_INTERVAL_MS', '-5'],
    ['OUTBOX_MAX_ATTEMPTS', '0'],
    ['OUTBOX_MAX_ATTEMPTS', '101'],
    ['OUTBOX_MAX_ATTEMPTS', '1.5'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => parseOutboxRelayConfig({ ...base, [key]: value })).toThrow();
  });
});
