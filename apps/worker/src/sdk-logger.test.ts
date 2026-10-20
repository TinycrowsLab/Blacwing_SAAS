import { describe, expect, it, vi } from 'vitest';

import { createSdkLogger } from './sdk-logger.js';

import type { Logger } from '@blackwing/logger';

const add = vi.hoisted(() => vi.fn());

vi.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: () => ({ createCounter: () => ({ add }) }) },
}));

function fakeLogger(): { log: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const sdk = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { log: { child: () => sdk } as unknown as Logger, warn };
}

describe('createSdkLogger', () => {
  it('counts poll failures (connection loss) without throwing and keeps logging', () => {
    const { log, warn } = fakeLogger();
    const sdk = createSdkLogger(log);
    expect(() => {
      sdk.warn('Failed to poll for task, retrying', { taskQueue: 'retention' });
    }).not.toThrow();
    sdk.error('Poll activity task failed: transport error');
    sdk.info('Worker state changed polling');
    sdk.warn('unrelated warning');
    expect(add).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      { sdk: { taskQueue: 'retention' } },
      'Failed to poll for task, retrying',
    );
  });
});
