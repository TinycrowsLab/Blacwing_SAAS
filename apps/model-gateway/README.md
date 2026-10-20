# @blackwing/model-gateway

Anthropic-Messages-compatible proxy between Claude Code (agent sandboxes set `ANTHROPIC_BASE_URL` to it) and
the model provider. It is the only place real provider credentials live (CONTEXT_PACK §4.1) and the
enforcement point for redaction (§8.7). GATEWAY-001 (#404) built the skeleton described here. Later
GATEWAY issues add virtual keys, the adapter set, redaction, metering and caps on top of it.

## Endpoints

| Route | Behaviour |
|---|---|
| `POST /v1/messages` | Streaming passthrough to the default provider. Both `stream: true` (SSE) and JSON responses are piped chunk by chunk and never buffered whole, so the client receives the upstream bytes unchanged. The query string (for example `?beta=true`) is forwarded too. |
| `GET /healthz` | Liveness: `200 {"status":"ok"}`. |
| `GET /readyz` | `200 {"status":"ready"}`, or `503` while draining or when the adapter is not ready. |
| `GET /metrics` | Prometheus text: `bw_gw_requests_total{route,status}`, `bw_gw_request_duration_ms{route,status}`, `bw_gw_upstream_inflight`. |

Errors use the Anthropic envelope `{"type":"error","error":{"type","message"}}` (not RFC 9457), so Claude
Code treats gateway errors like upstream errors. Responses for each failure:

| Case | Status / `error.type` |
|---|---|
| Body larger than `GATEWAY_MAX_BODY_BYTES` | `413 request_too_large` |
| Malformed JSON, or not a Messages request | `400 invalid_request_error` |
| Content type other than JSON | `415 invalid_request_error` |
| Unknown route | `404 not_found_error` |
| No upstream response headers within the timeout | `504 timeout_error` |
| Upstream unreachable | `502 api_error` |
| Upstream 4xx/5xx (429, 500, 529, …) | Passed through unchanged, including the body and `retry-after`. Retries come in GATEWAY-015. |

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
| `GATEWAY_DEFAULT_PROVIDER` | `anthropic` | The only adapter so far (`AnthropicAdapter`, official `@anthropic-ai/sdk`). |
| `GATEWAY_ANTHROPIC_BASE_URL` | required | There is no default, so the gateway never reaches a real provider by accident. Dev and tests use a local mock. |
| `GATEWAY_ANTHROPIC_API_KEY` | unset | A static dev credential. `OFFLINE-STUB(online-porting #884)`: production credentials come from OpenBao. |

Logs are structured as `{traceId, route, status, durationMs}`. Request and response bodies are never logged
(GATEWAY-013 owns the logging policy).

## Tests

`pnpm --filter @blackwing/model-gateway test` runs the unit tests and the in-process integration tests
against `src/testing/mock-anthropic.ts`, a local mock upstream on a random port with no network egress.
They cover stream and non-stream fidelity, irregular chunking, client-abort cleanup, size and JSON guards,
status passthrough, timeouts, traces and log hygiene.
