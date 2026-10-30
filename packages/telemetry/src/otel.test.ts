import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';

import { getMeter, getTracer, initTelemetry, shutdownTelemetry, withSpan } from './index.js';

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

// One SDK per test file: OpenTelemetry registers its global providers once per process, so this file
// owns the whole lifecycle and exports are asserted after the final shutdown. The recorders keep what
// was exported: the in-memory exporters clear their buffers when they are shut down.
const exportedSpans: ReadableSpan[] = [];
const spanExporter: SpanExporter = {
  export: (spans, resultCallback) => {
    exportedSpans.push(...spans);
    resultCallback({ code: ExportResultCode.SUCCESS });
  },
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
};
const exportedMetricNames: string[] = [];
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const pushMetrics = metricExporter.export.bind(metricExporter);
metricExporter.export = (resourceMetrics, resultCallback) => {
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) exportedMetricNames.push(metric.descriptor.name);
  }
  pushMetrics(resourceMetrics, resultCallback);
};
const exporters = {
  spans: spanExporter,
  logs: new InMemoryLogRecordExporter(),
  metrics: metricExporter,
};

const env = {
  NODE_ENV: 'test',
  OTEL_DEPLOYMENT_ENV: 'staging',
  OTEL_TRACES_SAMPLER: 'always_on',
} as const;

describe('initTelemetry with in-memory exporters', () => {
  it('boots the SDK and returns the same instance on a second call (idempotent)', () => {
    const first = initTelemetry({
      serviceName: 'api',
      serviceVersion: '1.2.3',
      instanceId: 'instance-1',
      env,
      exporters,
    });
    const second = initTelemetry({ serviceName: 'other', env, exporters });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('runs a block as a span whose attributes pass the safeAttr guard', () => {
    const result = withSpan('kill.run', () => 'stopped', {
      'run.id': 'run-7',
      email: 'owner@example.test',
      'auth.header': 'bw_pat_leaked',
    });
    expect(result).toBe('stopped');
    getTracer('test').startSpan('manual.span').end();
    getMeter('test').createCounter('kill.count').add(1, { reason: 'operator' });
  });

  it('records a thrown error on the span and rethrows it unchanged', () => {
    const boom = new Error('boom');
    expect(() =>
      withSpan('failing.step', () => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  it('awaits an async block and records a rejection, rethrowing it', async () => {
    await expect(withSpan('async.ok', () => Promise.resolve(42))).resolves.toBe(42);
    const rejected = new Error('async boom');
    await expect(withSpan('async.fail', () => Promise.reject(rejected))).rejects.toBe(rejected);
  });

  it('flushes spans and metrics on shutdown, with resource attributes and no tenant on the resource', async () => {
    await shutdownTelemetry();
    await shutdownTelemetry();

    const finished = exportedSpans;
    const names = finished.map((span) => span.name);
    expect(names).toEqual(
      expect.arrayContaining(['kill.run', 'manual.span', 'failing.step', 'async.ok', 'async.fail']),
    );

    const killRun = finished.find((span) => span.name === 'kill.run');
    expect(killRun?.attributes).toMatchObject({ 'run.id': 'run-7' });
    expect(killRun?.attributes).not.toHaveProperty('email');
    expect(killRun?.attributes).not.toHaveProperty('auth.header');

    const resource = killRun?.resource.attributes ?? {};
    expect(resource).toMatchObject({
      'service.name': 'api',
      'service.version': '1.2.3',
      'service.instance.id': 'instance-1',
      'deployment.environment': 'staging',
    });
    expect(resource).not.toHaveProperty('tenant_id');

    const failing = finished.find((span) => span.name === 'failing.step');
    expect(failing?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failing?.events.some((event) => event.name === 'exception')).toBe(true);

    expect(exportedMetricNames).toContain('kill.count');
    expect(exportedMetricNames).toContain('app_telemetry_initialized');
  });
});
