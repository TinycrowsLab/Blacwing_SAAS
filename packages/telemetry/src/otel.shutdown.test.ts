import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { describe, expect, it, vi } from 'vitest';

import { getTracer, initTelemetry, SHUTDOWN_TIMEOUT_MS, shutdownTelemetry } from './index.js';

import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

describe('shutdownTelemetry against a stuck collector', () => {
  it('gives up after SHUTDOWN_TIMEOUT_MS and resolves so the process can exit', async () => {
    vi.useFakeTimers();
    try {
      // An exporter that never answers: the final flush can only end by timing out.
      const hangingSpans: SpanExporter = {
        export: () => {
          // Never calls back.
        },
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      };
      initTelemetry({
        serviceName: 'api',
        env: { NODE_ENV: 'test', OTEL_TRACES_SAMPLER: 'always_on' },
        exporters: {
          spans: hangingSpans,
          logs: new InMemoryLogRecordExporter(),
          metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        },
      });
      getTracer('test').startSpan('pending').end();

      let settled = false;
      const shutdown = shutdownTelemetry().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
