import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withAsyncValidators } from './async-validation';

import type { Resolver } from 'react-hook-form';

interface V {
  handle: string;
}

const ok: Resolver<V> = (values) => Promise.resolve({ values, errors: {} });
const options = { names: ['handle' as const], fields: {}, shouldUseNativeValidation: false };

describe('withAsyncValidators', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the async error after the debounce', async () => {
    const validate = vi.fn().mockResolvedValue('Handle taken');
    const resolver = withAsyncValidators(ok, { handle: validate }, 100);
    const pending = resolver({ handle: 'x' }, undefined, options);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(validate).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    );
    expect(result.errors).toEqual({ handle: { type: 'async', message: 'Handle taken' } });
  });

  it('cancels a stale check: only the latest value is sent and the stale call reports no async error', async () => {
    const validate = vi.fn().mockResolvedValue('Handle taken');
    const resolver = withAsyncValidators(ok, { handle: validate }, 100);
    const first = resolver({ handle: 'a' }, undefined, options);
    await vi.advanceTimersByTimeAsync(50);
    const second = resolver({ handle: 'ab' }, undefined, options);
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).errors).toEqual({});
    expect((await second).errors).toHaveProperty('handle');
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith('ab', expect.anything());
  });

  it('aborts the signal of an in-flight stale check', async () => {
    const signals: AbortSignal[] = [];
    const validate = vi.fn((_v: unknown, { signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise<string | undefined>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve('stale answer');
        });
      });
    });
    const resolver = withAsyncValidators(ok, { handle: validate }, 0);
    const first = resolver({ handle: 'a' }, undefined, options);
    await vi.advanceTimersByTimeAsync(1);
    const second = resolver({ handle: 'b' }, undefined, options);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    expect((await first).errors).toEqual({});
    signals[1]?.dispatchEvent(new Event('abort'));
    await second;
  });

  it('does not call the server for a field that already fails the schema', async () => {
    const validate = vi.fn();
    const failing: Resolver<V> = () =>
      Promise.resolve({ values: {}, errors: { handle: { type: 'min', message: 'Too short' } } });
    const result = await withAsyncValidators(failing, { handle: validate }, 0)(
      { handle: '' },
      undefined,
      options,
    );
    expect(validate).not.toHaveBeenCalled();
    expect(result.errors).toEqual({ handle: { type: 'min', message: 'Too short' } });
  });

  it('fails open when the check throws (server re-validates on submit)', async () => {
    const validate = vi.fn().mockRejectedValue(new TypeError('offline'));
    const pending = withAsyncValidators(ok, { handle: validate }, 0)(
      { handle: 'x' },
      undefined,
      options,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).errors).toEqual({});
  });
});
