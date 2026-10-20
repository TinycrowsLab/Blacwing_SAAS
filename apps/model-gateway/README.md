# @blackwing/model-gateway

Anthropic-Messages-compatible proxy between Claude Code (agent sandboxes set `ANTHROPIC_BASE_URL` to it) and
the model provider. It is the only place real provider credentials live (CONTEXT_PACK §4.1) and the
enforcement point for redaction (§8.7). GATEWAY-001 (#404) built the skeleton described here. Later
GATEWAY issues add virtual keys, the adapter set, redaction, metering and caps on top of it.

## Endpoints

| Route               | Behaviour                                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/messages` | Streaming passthrough to the default provider. Both `stream: true` (SSE) and JSON responses are piped chunk by chunk and never buffered whole, so the client receives the upstream bytes unchanged. The query string (for example `?beta=true`) is forwarded too. |
| `GET /healthz`      | Liveness: `200 {"status":"ok"}`.                                                                                                                                                                                                                                  |
| `GET /readyz`       | `200 {"status":"ready"}`, or `503` while draining or when the adapter is not ready.                                                                                                                                                                               |
| `GET /metrics`      | Prometheus text: `bw_gw_requests_total{route,status}`, `bw_gw_request_duration_ms{route,status}`, `bw_gw_upstream_inflight`.                                                                                                                                      |

Errors use the Anthropic envelope `{"type":"error","error":{"type","message"}}` (not RFC 9457), so Claude
Code treats gateway errors like upstream errors. Responses for each failure:

| Case                                            | Status / `error.type`                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Body larger than `GATEWAY_MAX_BODY_BYTES`       | `413 request_too_large`                                                                      |
| Malformed JSON, or not a Messages request       | `400 invalid_request_error`                                                                  |
| Content type other than JSON                    | `415 invalid_request_error`                                                                  |
| Unknown route                                   | `404 not_found_error`                                                                        |
| No upstream response headers within the timeout | `504 timeout_error`                                                                          |
| Upstream unreachable                            | `502 api_error`                                                                              |
| Upstream 4xx/5xx (429, 500, 529, …)             | Passed through unchanged, including the body and `retry-after`. Retries come in GATEWAY-015. |

## Headers

- `anthropic-version`, `anthropic-beta` and `content-type` are preserved. A missing `anthropic-version`
  is set to the pinned `DEFAULT_ANTHROPIC_VERSION` (`@blackwing/contracts`), and a `gw.anthropic_version_defaulted` warning is logged.
- Hop-by-hop headers (RFC 9110 §7.6.1, plus names listed in `Connection`) are removed in both directions.
- Client credentials (`authorization`, `x-api-key`, `cookie`) are never forwarded. The adapter injects the
  provider credential instead. Upstream `set-cookie` is not returned.
- Upstream is asked for `accept-encoding: identity`, so bytes pass through without being decoded.
- W3C `traceparent` is read from the client. The `gw.messages` span continues that trace and is propagated upstream.

## Timeouts and cancellation

`GATEWAY_UPSTREAM_TIMEOUT_MS` limits the wait for upstream response headers. It also limits the silence
between two streamed chunks, so long but active streams are not cut off. If the client disconnects, the
upstream request is aborted at once, and the inflight gauge and socket are released.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `GATEWAY_HOST` | `0.0.0.0` | |
| `GATEWAY_PORT` | `8081` | The dev map uses `13500` (`.env.example`). |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | `120000` | Accepts `ms` or a unit (`30s`, `2m`). Must be greater than 0. |
| `GATEWAY_MAX_BODY_BYTES` | `10485760` | |
| `GATEWAY_DEFAULT_PROVIDER` | `anthropic` | `anthropic` (`AnthropicAdapter`, official `@anthropic-ai/sdk`) or `dev_subscription` (POC only, below). |
| `GATEWAY_ANTHROPIC_BASE_URL` | required | There is no default, so the gateway never reaches a real provider by accident. Dev and tests use a local mock. |
| `GATEWAY_ANTHROPIC_API_KEY` | unset | A static dev credential. `OFFLINE-STUB(online-porting #884)`: production credentials come from OpenBao. |
| `BW_ENV` | unset | `dev`, `test`, `staging` or `production`. Anything but `dev` keeps `dev_subscription` refused. |
| `GATEWAY_DEV_SUBSCRIPTION_ENABLED` | `false` | Explicit opt-in for `dev_subscription`. |
| `GATEWAY_DEV_SUBSCRIPTION_CREDENTIALS_FILE` | `~/.claude/.credentials.json` | Claude Code login file on the host. |
| `GATEWAY_DEV_SUBSCRIPTION_TENANT_IDS` | unset | Comma-separated dev/demo tenant UUIDs; all other tenants are denied. |
| `GATEWAY_DEV_VIRTUAL_KEY_SHA256` | unset | SHA-256 (hex) of the one dev `bwk_` key, until per-session keys (#405) land. |
| `GATEWAY_DEV_SUBSCRIPTION_BANNER_INTERVAL_MS` | `300000` | How often the WARN banner repeats. |

## Dev subscription provider (POC only, #883)

`dev_subscription` lets the internal POC call the model with the repo owner's local Claude Code login. It
must never power customer runs (CONTEXT_PACK §4.5). `OFFLINE-STUB(online-porting #884)`: the production
provider (Anthropic API key or Bedrock) replaces it.

- **Code-level guard.** The provider is registered only with `BW_ENV=dev` and
  `GATEWAY_DEV_SUBSCRIPTION_ENABLED=true`. Any other combination with the provider configured exits at boot
  with code 78 (`gw.boot_refused`), and the adapter re-checks the guard on every request (403 otherwise).
  It also needs the dev tenant list and the dev virtual key hash, or boot is refused.
- **Credential handling.** The login is read from the credential file inside the gateway process on each
  request (a login the CLI refreshed is picked up), registered for redaction, and sent upstream as
  `Authorization: Bearer` with the `oauth-2025-04-20` beta. It is never put in env, config, logs, traces or
  sandboxes. Sandboxes authenticate with a `bwk_` virtual key only. Any echo of the login in an upstream
  header or body is replaced with `[REDACTED]`, even when split across stream chunks.
- **Failure modes.** A missing, unreadable or expired login gets an Anthropic-shaped 401 that says to sign in
  again with the CLI. There is no fallback to any other credential. A subscription 429 is passed through with
  `retry-after` (from `retry-after`, else `anthropic-ratelimit-unified-reset`, else 30 s). Streams pass through.
- **Observability.** At boot the banner `DEV SUBSCRIPTION PROVIDER ACTIVE - INTERNAL POC ONLY - NOT FOR
CUSTOMER RUNS` goes to stderr and a WARN log line that repeats on the interval. The audit event
  `gateway.dev_provider.active` is emitted at boot, and `gateway.request` (with the provider id and tenant)
  for every request. Metrics carry `provider="dev_subscription"`.
- **Never in production.** Do not set these keys in staging or production values or Helm charts. The guard
  refuses them there anyway.

Logs are structured as `{traceId, route, status, durationMs}`. Request and response bodies are never logged
(GATEWAY-013 owns the logging policy).

## Tests

`pnpm --filter @blackwing/model-gateway test` runs the unit tests and the in-process integration tests
against `src/testing/mock-anthropic.ts`, a local mock upstream on a random port with no network egress.
They cover stream and non-stream fidelity, irregular chunking, client-abort cleanup, size and JSON guards,
status passthrough, timeouts, traces and log hygiene.
