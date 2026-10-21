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
