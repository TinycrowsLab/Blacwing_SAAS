# @blackwing/telemetry

OpenTelemetry bootstrap for every Node app (CONTEXT_PACK §5, OBS-001 #298), plus the workflow context that carries
`tenant_id` and run ids across Temporal calls.

## Usage

Call `initTelemetry` once, at the top of the entrypoint, before any instrumented module is imported:

```ts
import { initTelemetry, shutdownTelemetry, withSpan, safeAttr } from '@blackwing/telemetry';

initTelemetry({ serviceName: 'api', serviceVersion: '1.2.3' });
await withSpan('plan.load', async () => loadPlan(), { ...safeAttr('plan.id', planId) });
process.once('SIGTERM', () => void shutdownTelemetry().finally(() => process.exit(0)));
```

Per-app wiring is OBS-002. This package provides the bootstrap only.

## Environment

Read through `@blackwing/config` (`telemetryConfigSchema`). Every key has a default.

| Key | Default | Meaning |
|---|---|---|
| `OTEL_SDK_DISABLED` | `false` | `true` starts nothing; every helper is a no-op that still runs its block. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4317` | OTLP gRPC endpoint for traces, metrics and logs. |
| `OTEL_DEPLOYMENT_ENV` | `dev` | Resource attribute `deployment.environment`. |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | One of the six OpenTelemetry sampler names. |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0`, or `0.1` when `OTEL_DEPLOYMENT_ENV=production` | Sampling ratio from 0 to 1. |
| `OTEL_METRIC_EXPORT_INTERVAL_MS` | `15000` | Metric export interval. |

## Behaviour

- **Idempotent.** A second `initTelemetry` returns the running SDK.
- **Best-effort export.** Spans and log records wait in bounded queues. A failed export is retried with exponential
  backoff (1 s doubling to 30 s). A full queue drops its oldest items and counts them in
  `otel_export_dropped_total`. Failed exports count in `otel_exporter_errors_total`. Neither blocks the request path.
- **Collector down at boot.** `initTelemetry` still returns. Telemetry buffers until the collector answers.
- **Shutdown.** `shutdownTelemetry` flushes for at most 5 s, then resolves. It never throws.
- **Clock skew.** Each span and log carries its own process timestamp. Timelines across hosts are only as accurate as
  their clocks (NTP). Compare durations within one span, not start times across hosts.
- **Tenancy (§8.6).** `tenant_id` is a span or log attribute set per request, never a resource attribute and never a
  metric label.
- **Attribute guard (§8.7).** `safeAttr(key, value)` returns `{ [key]: value }`, or `{}` when the key is a
  credential or PII key (`email`, `password`, `token`, `authorization`, ...) or the value carries a secret-ref
  (`bwk_`, `bw_pat_`, `bw_ci_`, run tokens, built-in credential shapes). `withSpan` applies the same guard to its
  attributes.

## Not in this package

- Log-to-trace correlation is `@blackwing/logger`'s job (it reads the active span).
- Collector configuration is OBS-003.
