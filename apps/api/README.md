# @blackwing/api

Control-plane API: NestJS 11 on the Fastify adapter (CONTEXT_PACK §3.1, §5). REST lives under `/v1`;
`/health*`, `/graphql` and `/internal/broker/*` are served outside the prefix.

```sh
pnpm --filter @blackwing/api dev     # tsx watch, hot reload (dev port 13400 from .env)
pnpm --filter @blackwing/api build   # tsc -b, emits dist/
pnpm --filter @blackwing/api test    # unit + boot + child-process shutdown tests
```

## Configuration

Validated with Zod through `@blackwing/config` at boot. Any missing or invalid key refuses to start
(`CONFIG_INVALID`, exit 78) before anything listens.

| Key | Default | Notes |
|---|---|---|
| `NODE_ENV` | required | `development`, `test`, `staging`, `production` |
| `WEB_ORIGIN` | required | Comma-separated CORS origins (the web console) |
| `API_PORT` | `3000` | The dev map uses `13400` (`.env.example`) |
| `API_HOST` | `0.0.0.0` | |
| `API_BODY_LIMIT_BYTES` | `1048576` | Larger bodies get `413` before any handler runs |
| `API_TRUST_PROXY` | `true` | `X-Forwarded-*` is honoured only when true |
| `API_SHUTDOWN_GRACE_MS` | `10000` | Drain window after SIGTERM/SIGINT |
| `API_IDEMPOTENCY_TTL_S` | `86400` | How long a stored `Idempotency-Key` result is replayed |
| `API_IDEMPOTENCY_LOCK_TTL_S` | `120` | How long an `in_progress` marker blocks duplicates (crash recovery) |
| `API_IDEMPOTENCY_MAX_BODY_BYTES` | `65536` | Largest response body stored for replay |

## Request pipeline

- `bootstrap/create-app.ts` wires the Fastify adapter (body limit, proxy trust, `rawBody: true` for later
  signature checks), pino as Nest's logger (`bufferLogs`), the global prefix, Helmet and CORS.
- Every request gets a `traceId`: the trace id of a valid `traceparent`, else a well-formed
  `x-request-id` (first value wins), else a fresh UUIDv7. It is echoed as `x-request-id` and is only a
  correlation id, never an input to security decisions.
- `bootstrap/request-context.ts` registers `@fastify/request-context` with `traceId` and a request
  logger, opens an OpenTelemetry server span (`HTTP <method> <route>`) continued from `traceparent`,
  writes one `http.request` log line (`traceId`, `method`, `path`, `route`, `statusCode`, `durationMs`,
  `tenantId?`) and records `http_server_requests_total` / `http_server_request_duration_seconds`.
  `bindTenant()` is the hook later authentication uses to attach the verified tenant (§8.6).
- On SIGTERM/SIGINT the listener closes, in-flight requests finish (cut once the grace window elapses)
  and the process exits 0.

## Pagination and list filters (API-005)

`src/pagination/` gives every list endpoint cursor (keyset) pagination, an allowlisted filter/sort parser
and `Page<T>` (`{ items, nextCursor, hasMore }`). `PageQuerySchema` and `Page<T>` live in
`@blackwing/contracts`.

- Query: `?cursor=&limit=` (default 50, clamped to 200, `limit=0` is `400`), `sort=field[:asc|desc]`,
  `filter[field]=v`, `filter[field][op]=v` (ops: `eq ne lt lte gt gte in prefix`, per-field allowlist).
- A feature supplies a `ListSpec` (sort and filter allowlists, the unique `id` tiebreaker), calls
  `parseListQuery`, then `listPage({ fetch })`, where `fetch` runs `.where(plan.where).orderBy(...plan.orderBy).limit(plan.fetchLimit)` inside `withTenant` (RLS applies).
- Cursors are `base64url(json).base64url(hmac)` keyed by `API_CURSOR_SECRET` (>= 32 chars, `createCursorCodec`
  fails closed otherwise) and are bound to the sort, direction and filters. A forged, stale or mismatched
  cursor is `400 invalid_cursor`; a non-allowlisted field, operator, sort or value is `400 invalid_filter`.
- ORDER BY and the keyset predicate share one expression per column: strings use `COLLATE "C"`, timestamps
  are compared at millisecond precision (`date_trunc('milliseconds', col)`; add a matching expression index
  for hot lists). Forward-only. Rows inserted between pages appear only if they sort after the cursor.
- Metrics: `list_page_size`, `list_requests_total{route}` (`createListMetrics`).
## Idempotency-Key (API-008)

`src/idempotency/` makes retries of creating routes (runs, exports, tickets) safe. A feature marks a handler
with `@Idempotent()`; `IdempotencyModule` (mounted by `AppModule`) supplies the interceptor, the `onSend`
hook and the store. `createApiApp({ idempotencyStore })` takes a `ValkeyIdempotencyStore(client)` (any ioredis
client); without a store every `@Idempotent()` route answers `503` (fail closed).

- Missing header: `400 idempotency_key_required`; a malformed one (8 to 255 visible ASCII, one value): `400 bad_request`.
- Record: `idem:{tenantId}:{route}:{sha256(key)}` holding `{keyHash, fingerprint, state, result}`. The tenant comes
  from the request context (`bindTenant`); none means `500 tenant_context_missing`, never a shared key. The raw
  key is never stored. `fingerprint = sha256(method + path + sorted query + canonical JSON body)`.
- First request: `SET ... NX PX API_IDEMPOTENCY_LOCK_TTL_S` marks it `in_progress`. A duplicate meanwhile is
  `409 idempotency_in_progress` (`Retry-After: 1`); a crash leaves the marker to expire, then a retry proceeds.
  A reused key with another fingerprint is `409 idempotency_conflict` in any state.
- Completion happens in the `onSend` hook, so the stored status, headers (`content-type`, `location`, `etag`,
  `content-location`, `content-language`) and body are exactly what was sent. Replays carry the original
  status and `Idempotency-Replayed: true`, kept for `API_IDEMPOTENCY_TTL_S`.
- Cached: `2xx` and deterministic `4xx`. Never cached: `5xx`, redirects, and the transient `401 403 408 409 423 425 429`
  (the marker is dropped so a genuine retry runs again).
- Secrets are redacted before storing (sensitive JSON members become `[REDACTED]`, so a replay of a one-time secret
  shows the placeholder: do not put such an endpoint behind `@Idempotent()` if the replay must carry the secret).
  Only JSON and text bodies are stored; a body above `API_IDEMPOTENCY_MAX_BODY_BYTES` or of another type is
  flagged, and its replay is `409 idempotency_result_too_large` (read the created resource instead).
- Outage trade-off: if Valkey errors, creation is refused with `503 idempotency_unavailable` (`Retry-After: 5`)
  rather than risking a double create, so no `@Idempotent()` route accepts requests while Valkey is down. If Valkey
  fails only after the work ran, the response is still sent; the marker then expires after the lock TTL.
- Metrics: `idempotency_hits_total`, `idempotency_conflicts_total`, `idempotency_inflight_total` (by route template),
  `idempotency_store_errors_total{operation}`. Logs `idempotency.replay|conflict|in_progress|unavailable` with
  `traceId` and route, never the key or the body.
- Wiring the Valkey client into the process entry point arrives with the API's connection setup (health probes
  use the same client); no route is `@Idempotent()` yet.

## Internal Run Broker API (API-014)

`/internal/broker/runs/{runId}/{candidates|evidence|journal|state}` is mounted by `registerBrokerRoutes`
(`src/broker`), outside `/v1` and outside the public OpenAPI document (`brokerOpenApiDocument()` is its own
internal spec). Per request, in order: source guard (socket CIDR in `BROKER_ALLOWED_CIDRS` AND the mesh
identity header in `BROKER_MESH_IDENTITIES`; `X-Forwarded-For` is never trusted; anything missing refuses with
403), `Authorization: Bearer bwrun_...` token (401), revocation, per-run-session rate limit (429), then scope,
path/body run binding (403, never revealing other runs), body validation (422), a second revocation check, the
tenant-scoped run lookup and the run state (`409 run_not_active` for writes on a terminal run). Valid calls
answer `501 not_implemented` until FINDING, EVIDENCE, REVERSAL and ORCH implement them. Tokens are minted by
`signBrokerToken` (issuance wiring: RUNTIME/SANDBOX). Metrics: `broker_requests_total`,
`broker_auth_failures_total`. In-memory stores are offline stubs (online-porting #895).
