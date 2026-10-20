# @blackwing/sandbox-controller

Creates and destroys per-run sandboxes, run networks and CA material (CONTEXT_PACK §3.1, §6). It is called
by the Run Controller (`apps/worker`) over the internal control-plane network and is never reachable from a
sandbox. SANDBOX-001 (#448) is the chassis: config, server, auth, readiness, metrics, shutdown. Drivers
(SANDBOX-003/004), the spec builder (SANDBOX-007) and lifecycle routes (SANDBOX-010) plug into it.

## Run

```sh
pnpm --filter sandbox-controller start      # tsx src/main.ts, reads the environment below
pnpm --filter sandbox-controller test       # unit
pnpm --filter sandbox-controller test:int   # Testcontainers Valkey + real process
```

## Configuration

| Key | Default | Notes |
|---|---|---|
| `SBX_MGMT_ADDR` | `:7070` | `host:port`; empty host = every interface of the controller pod. Dev: `127.0.0.1:13700`. |
| `SBX_DRIVER` | `kubernetes` | `kubernetes` or `docker`. |
| `SBX_NAMESPACE` | `bw-runs` | RFC 1123 label. |
| `SBX_RUNTIME_CLASS` | `gvisor` | RFC 1123 label. |
| `SBX_IMAGE_DIGEST` | required | Must be pinned `@sha256:` (§8.9); tags are refused. |
| `SBX_TTL_SECONDS` | `3600` | 1 to 86400. |
| `SBX_DRAIN_TIMEOUT` | `10s` | Drain budget on SIGTERM/SIGINT. |
| `SBX_MAX_BODY_BYTES` | `1048576` | Larger bodies get 400 `SBX_BAD_REQUEST`. |
| `SBX_RUN_TOKEN_SECRET` | required | HMAC key for `bw_run_` tokens, at least 32 characters. Secret. |
| `VALKEY_URL` | required | `redis://` or `rediss://`. Secret. |
| `SBX_BUILD_COMMIT` | `unknown` | Reported by `sbx_build_info`. |
| `NODE_ENV`, `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT` | | From the shared base schema. |

Invalid configuration prints `SBX_CONFIG_INVALID: <keys and reasons>` (never values) to stderr and exits
78 before any socket is bound.

## HTTP surface

- `GET /healthz`: liveness, always 200 while the process serves.
- `GET /readyz`: 200 only when the driver and Valkey answered their latest probe. Failing probes retry
  with exponential backoff (250 ms doubling to 30 s), and healthy ones are re-probed every 5 s. The default
  build has no driver yet, so it stays 503 (fail closed).
- `GET /metrics`: Prometheus. `sbx_up`, `sbx_ready`, `sbx_build_info{version,commit}`,
  `sbx_auth_failures_total{reason}`.
- `/internal/sandboxes/*`: requires `Authorization: Bearer bw_run_<payload>.<sig>`. The check runs before
  routing and body parsing. Missing, invalid, forged, expired or wrong-audience tokens all get the same
  401 problem+json `SBX_UNAUTHENTICATED`. Handlers read `request.runContext` (`tenantId`, `runId`).
  Malformed or oversized JSON gets 400 problem+json `SBX_BAD_REQUEST`.

### Run-scoped token

`bw_run_` + base64url(JSON `{v:1, aud, tid, rid, iat, exp}`) + `.` + base64url(HMAC-SHA256(key,
`bw_run_` + payload)). `aud` must be `sandbox-controller`, so a token minted for another internal
service is refused. `signRunToken` is the issuer helper. Tokens are redacted from every log line by the
shared `run-token` pattern.

## Shutdown

SIGTERM/SIGINT marks the process not ready, stops accepting connections and drains in-flight requests
for up to `SBX_DRAIN_TIMEOUT`. During the drain each response closes its connection. After the timeout the
remaining connections are cut and the process exits 1, otherwise it exits 0. It then emits
`sandbox_controller.stopped` and flushes telemetry. SIGKILL skips the drain. Creates must therefore be
idempotent (SANDBOX-010).

## Audit and logs

`sandbox_controller.started`/`stopped` carry a SHA-256 config hash. Secret keys count only as present,
never by value. Until the `@blackwing/audit` emitter (#82) lands they are written as structured `audit`
log lines. Logs are pino JSON via `@blackwing/logger`, with `component`, and on internal requests also
`tenant_id`, `run_id` and `sandbox_id`.
