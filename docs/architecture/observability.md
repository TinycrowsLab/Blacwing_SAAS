# Observability: service instrumentation (OBS-002, #299)

Every runnable service starts the OpenTelemetry SDK through one shared bootstrap, so traces, metrics and logs
carry a stable `service.name`. The collector endpoint comes from `OTEL_EXPORTER_OTLP_ENDPOINT` (OBS-001, INFRA).
Without it, signals are recorded but not exported.

## Service registry

| Service (`service.name`) | Entry point | Bootstrap |
|---|---|---|
| `web` | `apps/web/src/instrumentation.ts` (Next.js hook, Node runtime only) | `apps/web/src/instrument.ts` |
| `api` | `apps/api/src/main.ts` | `apps/api/src/instrument.ts` |
| `worker` | `apps/worker/src/main.ts` | `apps/worker/src/instrument.ts` |
| `agent-runtime` | `apps/agent-runtime/src/main.ts` | `apps/agent-runtime/src/instrument.ts` |
| `model-gateway` | `apps/model-gateway/src/main.ts` | `apps/model-gateway/src/instrument.ts` |
| `session-manager` | `apps/session-manager/src/main.ts` | `apps/session-manager/src/instrument.ts` |
| `sandbox-controller` | `apps/sandbox-controller/src/main.ts` | `apps/sandbox-controller/src/instrument.ts` |
| `egress-gateway` (Go) | `apps/egress-gateway/cmd/gateway/main.go` | `apps/egress-gateway/internal/telemetry` |

Each TS bootstrap calls `initTelemetry({ serviceName })` from `@blackwing/telemetry`. The shared auto-instrumentation
subset is HTTP, NestJS core, `pg` and `ioredis`, from `packages/telemetry/src/instrumentations.ts`. Fastify (the
HTTP layer under NestJS, §5) has no dedicated instrumentation: `@opentelemetry/instrumentation-fastify` is deprecated
upstream in favour of `@fastify/otel`, a per-instance plugin. Server spans come from HTTP instrumentation.

## Rules

- **Import order.** `./instrument.js` is the first import of each entrypoint, so instrumented libraries are patched
  before anything loads them. `scripts/check-instrument-order.mjs` (`pnpm check:instrument-order`) enforces this.
- **Edge runtime excluded.** Next.js edge routes are not instrumented. Client-side telemetry is out of scope for v1.
- **Propagation.** Node and Go both use W3C `tracecontext` and `baggage`, so an `api` trace continued in `worker`
  shares one `traceId` (OBS-008).
- **Metadata only (§8.7, §8.6).** Instrumentation records method, route, status and statement shape. It never records
  request or response bodies or credential-bearing headers. `tenantId` and `runId` appear as attributes only where
  already in context.
- **Collector down.** Exporters connect lazily and buffer with a bounded queue, so the service keeps serving (OBS-001).

## Signals per service

- Every TS service sets `app_telemetry_initialized{service}` to 1 once the SDK starts.
- `egress-gateway` emits an `egress.startup` span on boot, and `egress.http.requests{decision,method}` counts proxy
  requests. Its Prometheus `egress_http_requests_total` remains the in-cluster scrape target.
- The gateway does not instrument per-connection payloads. A test asserts that no span attribute carries body bytes.
