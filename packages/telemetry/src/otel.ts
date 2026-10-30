import { randomUUID } from 'node:crypto';

import {
  type Attributes,
  type Meter,
  metrics,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import {
  type AggregationOption,
  AggregationTemporality,
  AggregationType,
  type InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  type Sampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { safeAttr } from './attributes.js';
import {
  type OtelSampler,
  readTelemetryConfig,
  samplerRatio,
  type TelemetryConfig,
} from './config.js';
import { isExportSuccess, QueuedLogRecordProcessor, QueuedSpanProcessor } from './processors.js';

import type { EnvSource } from '@blackwing/config';
import type { ExportResult } from '@opentelemetry/core';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';

/** Instrumentation scope of the telemetry package's own self-metrics. */
const TELEMETRY_SCOPE = '@blackwing/telemetry';

/** How long {@link shutdownTelemetry} waits for the final flush (OBS-001: SIGTERM flushes within 5 s). */
export const SHUTDOWN_TIMEOUT_MS = 5000;

const log = createLogger(TELEMETRY_SCOPE);

/** The exporters `initTelemetry` sends signals through. Production leaves them unset (OTLP over gRPC). */
export interface TelemetryExporters {
  readonly spans: SpanExporter;
  readonly logs: LogRecordExporter;
  readonly metrics: PushMetricExporter;
}

/** Options for {@link initTelemetry}. */
export interface InitTelemetryOptions {
  /** `service.name` resource attribute. */
  readonly serviceName: string;
  /** `service.version` resource attribute. Default `unknown`. */
  readonly serviceVersion?: string | undefined;
  /** `service.instance.id` resource attribute. Default: a fresh UUID for this process. */
  readonly instanceId?: string | undefined;
  /** Environment the `OTEL_*` keys are read from. Default: the process environment, through `@blackwing/config`. */
  readonly env?: EnvSource | undefined;
  /** Replaces the OTLP exporters, for tests that assert on in-memory exporters. */
  readonly exporters?: TelemetryExporters | undefined;
}

interface ActiveTelemetry {
  /** `undefined` when `OTEL_SDK_DISABLED=true`: every helper then runs as a no-op. */
  readonly sdk: NodeSDK | undefined;
}

let active: ActiveTelemetry | undefined;

function buildSampler(sampler: OtelSampler, ratio: number): Sampler {
  switch (sampler) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
  }
}

function defaultExporters(endpoint: string): TelemetryExporters {
  return {
    spans: new OTLPTraceExporter({ url: endpoint }),
    logs: new OTLPLogExporter({ url: endpoint }),
    metrics: new OTLPMetricExporter({ url: endpoint }),
  };
}

/** Wraps a metric exporter to count failed pushes, delegating everything else unchanged. */
class CountingMetricExporter implements PushMetricExporter {
  constructor(
    private readonly inner: PushMetricExporter,
    private readonly onError: () => void,
  ) {}

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.inner.export(metrics, (result) => {
      if (!isExportSuccess(result)) this.onError();
      resultCallback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return (
      this.inner.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE
    );
  }

  selectAggregation(instrumentType: InstrumentType): AggregationOption {
    return this.inner.selectAggregation?.(instrumentType) ?? { type: AggregationType.DEFAULT };
  }
}

function resourceFor(options: InitTelemetryOptions, config: TelemetryConfig): Resource {
  return resourceFromAttributes({
    'service.name': options.serviceName,
    'service.version': options.serviceVersion ?? 'unknown',
    'deployment.environment': config.OTEL_DEPLOYMENT_ENV,
    'service.instance.id': options.instanceId ?? randomUUID(),
  });
}

/**
 * Starts the OpenTelemetry SDK (traces, metrics and logs over OTLP gRPC) for this process. Call it once, at
 * the top of the app's entrypoint, before any instrumented module is imported.
 *
 * - Idempotent: a second call returns the SDK that is already running.
 * - Best-effort: an unreachable collector never fails this call. Exports are buffered in bounded queues and
 *   retried with backoff; the oldest items are dropped when a queue is full.
 * - `OTEL_SDK_DISABLED=true` starts nothing, and every helper in this module becomes a no-op.
 * - Throws `AppError` `TELEMETRY_INIT_FAILED` on invalid `OTEL_*` configuration or an SDK that refuses to start.
 *
 * Resource attributes are `service.name`, `service.version`, `deployment.environment` and
 * `service.instance.id`. `tenant_id` is never a resource attribute: it is attached per span or log (§8.6).
 */
export function initTelemetry(options: InitTelemetryOptions): NodeSDK | undefined {
  if (active !== undefined) {
    log.debug({ component: 'telemetry' }, 'telemetry.init.repeated');
    return active.sdk;
  }

  let config: TelemetryConfig;
  try {
    config = readTelemetryConfig(options.env);
  } catch (error) {
    throw new AppError('TELEMETRY_INIT_FAILED', 'invalid OpenTelemetry configuration', {
      cause: error,
    });
  }
  if (config.OTEL_SDK_DISABLED) {
    active = { sdk: undefined };
    log.info({ component: 'telemetry', disabled: true }, 'telemetry.init.disabled');
    return undefined;
  }

  const exporters = options.exporters ?? defaultExporters(config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const meter = metrics.getMeter(TELEMETRY_SCOPE);
  const droppedCounter = meter.createCounter('otel_export_dropped_total', {
    description: 'Telemetry items dropped because an export queue was full',
  });
  const errorCounter = meter.createCounter('otel_exporter_errors_total', {
    description: 'Failed telemetry export attempts',
  });
  const onDropped = (signal: string) => (count: number) => {
    droppedCounter.add(count, { signal });
  };
  const onExportError = (signal: string) => () => {
    errorCounter.add(1, { signal });
  };

  try {
    const sdk = new NodeSDK({
      resource: resourceFor(options, config),
      autoDetectResources: false,
      sampler: buildSampler(config.OTEL_TRACES_SAMPLER, samplerRatio(config)),
      spanProcessors: [
        new QueuedSpanProcessor(exporters.spans, {
          onDropped: onDropped('traces'),
          onExportError: onExportError('traces'),
        }),
      ],
      logRecordProcessors: [
        new QueuedLogRecordProcessor(exporters.logs, {
          onDropped: onDropped('logs'),
          onExportError: onExportError('logs'),
        }),
      ],
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new CountingMetricExporter(exporters.metrics, onExportError('metrics')),
          exportIntervalMillis: config.OTEL_METRIC_EXPORT_INTERVAL_MS,
        }),
      ],
    });
    sdk.start();
    active = { sdk };
    log.info(
      {
        component: 'telemetry',
        serviceName: options.serviceName,
        sampler: config.OTEL_TRACES_SAMPLER,
      },
      'telemetry.init',
    );
    return sdk;
  } catch (error) {
    throw new AppError('TELEMETRY_INIT_FAILED', 'OpenTelemetry SDK failed to start', {
      cause: error,
    });
  }
}

/**
 * Flushes buffered spans, logs and metrics, then stops the SDK. Waits at most {@link SHUTDOWN_TIMEOUT_MS}
 * and never throws: the caller exits right after. Safe to call when telemetry never started.
 */
export async function shutdownTelemetry(): Promise<void> {
  const current = active;
  active = undefined;
  if (current?.sdk === undefined) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
  const flushed = current.sdk.shutdown().then(
    () => 'flushed' as const,
    () => 'failed' as const,
  );
  const outcome = await Promise.race([flushed, timeout]);
  clearTimeout(timer);
  if (outcome === 'flushed') {
    log.info({ component: 'telemetry' }, 'telemetry.shutdown');
  } else {
    log.warn({ component: 'telemetry', outcome }, 'telemetry.shutdown.incomplete');
  }
}

/** The tracer for an instrumentation scope. A no-op tracer until {@link initTelemetry} has started the SDK. */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/** The meter for an instrumentation scope. A no-op meter until {@link initTelemetry} has started the SDK. */
export function getMeter(name: string): Meter {
  return metrics.getMeter(name);
}

function recordFailure(span: Span, error: unknown): void {
  const cause = error instanceof Error ? error : new Error(String(error));
  span.recordException(cause);
  span.setStatus({ code: SpanStatusCode.ERROR, message: cause.name });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Runs `fn` inside a new active span named `name` and ends the span when `fn` returns or, for a promise,
 * settles. A thrown error or a rejection is recorded on the span and rethrown unchanged. `attrs` pass through
 * {@link safeAttr}, so a secret or PII attribute never reaches the span.
 */
export function withSpan<T>(name: string, fn: () => Promise<T>, attrs?: Attributes): Promise<T>;
export function withSpan<T>(name: string, fn: () => T, attrs?: Attributes): T;
export function withSpan(name: string, fn: () => unknown, attrs?: Attributes): unknown {
  const safeAttributes =
    attrs === undefined
      ? undefined
      : Object.entries(attrs).reduce<Attributes>(
          (kept, [key, value]) => ({ ...kept, ...safeAttr(key, value) }),
          {},
        );
  return getTracer(TELEMETRY_SCOPE).startActiveSpan(
    name,
    safeAttributes === undefined ? {} : { attributes: safeAttributes },
    (span) => {
      try {
        const result = fn();
        if (isPromiseLike(result)) {
          return result.then(
            (value) => {
              span.end();
              return value;
            },
            (error: unknown) => {
              recordFailure(span, error);
              span.end();
              throw error;
            },
          );
        }
        span.end();
        return result;
      } catch (error) {
        recordFailure(span, error);
        span.end();
        throw error;
      }
    },
  );
}
