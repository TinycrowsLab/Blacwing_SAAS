# @blackwing/session-manager

Multi-role login, keep-alive, validity and lockout guard. It injects sessions at the egress gateway (CONTEXT_PACK
§3.1, §6). SESSION-001 (#612) is the chassis: typed config, lifecycle, health and readiness, metrics, structured
logging with a credential redaction serializer, a token-protected internal API, and graceful shutdown. The recipe
engine (SESSION-005..008), the store (SESSION-004) and injection (SESSION-012) plug into it.

## Run

```sh
pnpm --filter session-manager start        # tsx src/main.ts, reads the environment below
pnpm --filter session-manager test         # unit
pnpm --filter session-manager test:int     # Testcontainers Valkey and PostgreSQL, in-process drain
```

## Configuration

| Key | Default | Notes |
|---|---|---|
| `SM_MGMT_ADDR` | `:7080` | `host:port`; empty host = every interface. Never a sandbox-facing address. |
| `SM_SESSION_TTL_SECONDS` | `1800` | Validity window of a stored session, 1 to 86400. |
| `SM_DRAIN_TIMEOUT` | `10s` | Drain budget on SIGTERM/SIGINT. |
| `SM_MAX_BODY_BYTES` | `1048576` | Larger bodies get 400 `SM_BAD_REQUEST`. |
| `SM_RUN_TOKEN_SECRET` | required | HMAC key for `bw_run_` tokens, at least 32 characters. Secret. |
| `SM_CONTROL_TOKEN_SECRET` | required | HMAC key for `bw_ctl_` control-plane tokens, at least 32 characters. Secret. |
| `DATABASE_URL` | required | `postgres://` or `postgresql://`. Secret. |
| `VALKEY_URL` | required | `redis://` or `rediss://`. Secret. |
| `OPENBAO_ADDR` | `http://openbao:8200` | Credentials are resolved by reference through `@blackwing/secrets` (S8.7). |
| `SM_BUILD_COMMIT` | `unknown` | Reported by `sm_build_info`. |
| `NODE_ENV`, `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT` | | From the shared base schema. |

Invalid configuration prints `SM_CONFIG_INVALID: <keys and reasons>` (never values) to stderr and exits 78 before
any socket is bound.

## HTTP surface

- `GET /healthz`: liveness, always 200 while the process serves.
- `GET /readyz`: 200 only when PostgreSQL, Valkey and OpenBao (`/v1/sys/health`) all answered their latest probe.
  Failing probes retry with exponential backoff (250 ms doubling to 30 s); healthy ones are re-probed every 5 s.
  Until then it answers 503, so no session is served while a dependency is down (fail closed).
- `GET /metrics`: Prometheus. `sm_up`, `sm_ready`, `sm_build_info{version,commit}`, `sm_auth_failures_total{reason}`.
- `/internal/sessions/*`: needs `Authorization: Bearer <token>`, checked before routing and body parsing.
  - `bw_run_` (run-scoped) reaches only `/internal/sessions/tenants/{tenantId}/runs/{runId}/...`, for its own
    tenant and run.
  - `bw_ctl_` (control plane) reaches only `/internal/sessions/tenants/{tenantId}/...`, for its own tenant.
  - Missing, invalid, forged, expired or wrong-audience tokens get 401 `SM_UNAUTHENTICATED` (one body for every
    reason). A valid token for another tenant or run gets 403 `SM_TENANT_MISMATCH`.
  - Malformed or oversized JSON gets 400 `SM_BAD_REQUEST`.
  - Current routes are scope probes: `GET .../scope` on the tenant and on the run.

Every error is RFC 9457 problem+json, with codes registered in `@blackwing/errors`.

### Token format

`<prefix>` + base64url(JSON `{v:1, aud:"session-manager", tid, rid?, iat, exp}`) + `.` +
base64url(HMAC-SHA256(key, prefix + payload)). Each class has its own key, so a leaked run key cannot mint control
tokens. Tokens are never logged or echoed.

## Logging and redaction

Logs go through `@blackwing/logger` (pino JSON, `component` set per path). Every audit line and every problem
log passes through `redactLogValue`, which replaces credential fields (username, password, OTP, cookie, session,
and recipe bodies) and secret-shaped strings with `[REDACTED]`.

## Shutdown

SIGTERM/SIGINT marks the process not ready, stops accepting connections and drains in-flight requests for up to
`SM_DRAIN_TIMEOUT`. It emits `session_manager.stopped` (with `signal` and `drained`) and exits 0 when drained,
1 otherwise. A SIGKILL leaves no half-written state, because store writes arrive with SESSION-004 as transactions.
