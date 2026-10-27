import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@blackwing/ui';

import { toastApiError } from './api-error-toast';
import { ApiError } from './api-error.js';
import { makeQueryClient } from './query-client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toastApiError', () => {
  it('shows fixed copy with the trace id and never the server detail', () => {
    const spy = vi.spyOn(toast, 'error');
    toastApiError(
      new ApiError({
        status: 500,
        code: 'internal',
        title: 'Database exploded',
        detail: 'SELECT * FROM users WHERE token = "sk-live-secret"',
        traceId: 'trc_9f2a',
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]?.[0];
    expect(arg?.traceId).toBe('trc_9f2a');
    expect(JSON.stringify(arg)).not.toContain('sk-live-secret');
    expect(JSON.stringify(arg)).not.toContain('Database exploded');
    expect(JSON.stringify(arg)).not.toContain('SELECT');
  });

  it('still toasts a network failure that has no trace id', () => {
    const spy = vi.spyOn(toast, 'error');
    toastApiError(new ApiError({ status: 0, code: 'NETWORK', title: 'Network' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.traceId).toBeUndefined();
  });

  it('is wired to failed mutations so the user sees the trace id', async () => {
    const spy = vi.spyOn(toast, 'error');
    const client = makeQueryClient({ handlers: { onError: toastApiError } });
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => {
        throw new ApiError({ status: 500, code: 'internal', title: 'Boom', traceId: 'trc_77' });
      },
    });
    await expect(mutation.execute(undefined)).rejects.toThrow('Boom');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.traceId).toBe('trc_77');
  });

  it('does not toast 403 or 429, which have their own handling', async () => {
    const spy = vi.spyOn(toast, 'error');
    const client = makeQueryClient({ handlers: { onError: toastApiError } });
    for (const status of [403, 429]) {
      const mutation = client.getMutationCache().build(client, {
        mutationFn: () => {
          throw new ApiError({ status, code: 'denied', title: 'Denied' });
        },
      });
      await expect(mutation.execute(undefined)).rejects.toThrow('Denied');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
