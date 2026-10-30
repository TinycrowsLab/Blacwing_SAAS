import { trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { getMeter, getTracer, initTelemetry, shutdownTelemetry, withSpan } from './index.js';

describe('OTEL_SDK_DISABLED=true', () => {
  it('starts no SDK, and every helper becomes a no-op that still runs the block', async () => {
    const sdk = initTelemetry({
      serviceName: 'api',
      env: { NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' },
    });
    expect(sdk).toBeUndefined();

    expect(withSpan('noop.span', () => 'value')).toBe('value');
    await expect(withSpan('noop.async', () => Promise.resolve('async value'))).resolves.toBe(
      'async value',
    );
    expect(() =>
      withSpan('noop.fail', () => {
        throw new Error('still thrown');
      }),
    ).toThrow('still thrown');

    const span = getTracer('test').startSpan('noop');
    expect(span.isRecording()).toBe(false);
    span.end();
    getMeter('test').createCounter('noop.count').add(1);

    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});
