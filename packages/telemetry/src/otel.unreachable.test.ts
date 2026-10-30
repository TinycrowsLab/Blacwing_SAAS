import { describe, expect, it } from 'vitest';

import { initTelemetry, shutdownTelemetry, withSpan } from './index.js';

describe('an unreachable collector', () => {
  it('does not stop the app from booting or serving work', async () => {
    const sdk = initTelemetry({
      serviceName: 'api',
      env: {
        NODE_ENV: 'test',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
        OTEL_METRIC_EXPORT_INTERVAL_MS: '60000',
      },
    });
    expect(sdk).toBeDefined();
    expect(withSpan('request', () => 'served')).toBe('served');
    await shutdownTelemetry();
  }, 20000);
});
