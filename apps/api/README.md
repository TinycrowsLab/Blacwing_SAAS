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
| `API_GQL_MAX_DEPTH` | `10` | Deepest field nesting of one GraphQL operation; deeper ones answer `query_too_complex` |
| `API_GQL_MAX_COMPLEXITY` | `1000` | Estimated cost ceiling of one GraphQL operation (a list multiplies its children's cost) |
| `API_GQL_MAX_ALIASES` | `50` | Most aliased fields one GraphQL operation may carry |
| `SIGNUP_TOKEN_TTL_HOURS` | `24` | How long a signup verification link works (TENANT-004) |
| `SIGNUP_DEFAULT_REGION` | `eu-west-1` | Data region of a self-service tenant |
| `SIGNUP_EMAIL_MAX_PER_HOUR` | `5` | Verification mails one address may ask for per hour |
| `SIGNUP_VERIFY_URL` | first `WEB_ORIGIN` + `/signup/verify` | Console page the link opens; the token is in the `#token=` fragment |
| `API_GQL_PERSISTED_ONLY` | on in production, off otherwise | Only persisted queries run (a sha256 id from `graphql/persisted.json`); raw documents answer `persisted_query_required`. Run `pnpm graphql:persist` after changing a client operation |
| `KEYCLOAK_ADMIN_URL`, `KEYCLOAK_ADMIN_REALM`, `KEYCLOAK_ORG_ADMIN_CLIENT_ID`, `KEYCLOAK_ORG_ADMIN_SECRET_PATH` | unset | Keycloak Admin API for organisations (IAM-002). Set all four or none. The client secret is read from OpenBao at the secret path, never from env |

## Keycloak organisations (IAM-002)

`src/keycloak/` wraps the Keycloak Admin REST API for tenant Organizations. `createOrganizationsService` (in
`keycloak/index.ts`) builds `OrganizationsService`, which offers `createOrganization`, `getByAlias`, `update`,
`delete`, `addMember` and `removeMember`. Each is idempotent (a repeat is a no-op) and records an audit event
through the `OrganizationAuditSink` port (IAM-012 wires the ledger).
Keycloak's organisation `name` holds the tenant slug, and the display name is the `displayName` attribute.
`KeycloakAdminClient` uses a cached `client_credentials` token from the least-privilege service-account client,
renews it at 80% of its lifetime, re-reads the secret after a 401 and retries transient failures with backoff.
Keycloak failures map to `KEYCLOAK_UNAVAILABLE` (503, retryable), `KEYCLOAK_REJECTED` (500), `KEYCLOAK_NOT_FOUND`
(404) and `KEYCLOAK_CONFLICT` (409). Metric: `keycloak_admin_calls_total{op,result}`. Trace: one `keycloak.admin.<op>` span per call, with `bw.keycloak.op` and `bw.keycloak.result`. The service is not yet mounted
in a Nest module; TENANT-005 and IAM-003/004 consume it. Integration tests against a live Keycloak are tracked in #901.

## Per-organisation identity providers (IAM-004)

`src/keycloak/idp/` configures one generic OIDC or SAML 2.0 identity provider per organisation, brokered by Keycloak
for the tenant's Organization. `createIdentityProviderService` builds `IdentityProviderService`, which offers
`configure` (create or update, idempotent), `remove` and `exportSpMetadata` (the SP entityID, ACS URL and Keycloak's
descriptor for the customer to register). Only `org_admin` may call them. The caller is the canonical `Principal`,
and the tenant alone selects the organisation, so one tenant cannot touch another tenant's provider.

- OIDC: the issuer's discovery document is fetched over https (bounded, no redirects) and must name the same issuer, offer
  the code flow and PKCE S256. The client secret is an OpenBao reference, read at configure time and sent to Keycloak only.
- SAML: metadata by https URL or XML. XML is parsed without DTDs or entities (XXE, CWE-611), size and element budgets apply,
  and at least one signing certificate must be valid now (expired ones are dropped during rollover). Keycloak is always
  set to validate signatures and require signed assertions. The option cannot be switched off.
- Every applied change emits `auth.sso_config_changed` (metadata only, never secrets or certificates), increments
  `sso_idp_config_total{type,op}`, and sets `sso_idp_signing_cert_expiry_days{alias}` for SAML.
- Not mounted over HTTP yet, and not verified against a live Keycloak. See the online-porting follow-up in #904.

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

## GraphQL read layer (API-009)

`src/graphql/` serves a read-only GraphQL API at `/graphql` on the same Fastify server as REST (code-first
`@nestjs/graphql` on Mercurius). A composition root mounts it with
`GraphqlApiModule.forRoot({ config, logger, metrics, store })`, where `store` is a tenant-scoped
`MemberReadStore` (`createPgMemberReadStore(db)` against Postgres). `runApi` does not mount it yet: like the other
tenant data routes, it waits for the process to own a database handle. Writes stay on REST: the schema has no
`Mutation` type, so a mutation is refused by validation.

- **Tenant and authn.** The same global tenant guard, interceptor and rate limiter as REST run on each
  operation (`bootstrap/transport.ts` resolves the request for both transports). The principal is validated and
  charged once per operation, at its root field. Field resolvers read the tenant the root resolved onto the
  request and fail closed without it; every store read runs in `withTenant` (RLS).
- **Limits.** Depth, cost and alias count are checked in a validation rule before any resolver runs, so a
  rejected operation executes nothing. A list is priced by its `first` (literal or variable value, capped at
  200; absent: the resolver default of 20). Over a limit: `extensions.code: query_too_complex`. Mercurius' function
  form of `validationRules` needs the document cache off (`cache: false`); parse and validate run per request.
- **DataLoader.** Loaders are built per request in the context factory. `createTenantLoader` keys every entry by
  `(tenantId, id)`, so a batch never mixes tenants and a result never crosses them. `user` on a member is one
  store call per response.
- **Errors.** `errors[].extensions.code` mirrors the REST registry (`unauthenticated`, `permission_denied`,
  `validation_failed`, `rate_limited`, `query_too_complex`, ...). Partial failures keep `data` and list their
  `errors[]`. Server errors render `Internal server error`; no stack is ever rendered. Mercurius types error
  `path` items as strings in its response schema, so a list index arrives as `"0"` (a known deviation from the
  GraphQL spec that Mercurius owns).
- **Introspection and GraphiQL** are off when `NODE_ENV=production`.
- **Metrics** (`graphql_requests_total{operation}`, `graphql_complexity`, `graphql_rejected_total{reason}`) and one
  span per resolver (`graphql <Type>.<field>`). A rejected operation is logged as `graphql.query_rejected` with its
  name and reason, never its query text.
- **Schema.** `apps/api/schema.gql` is written from the decorators (`autoSchemaFile`). `pnpm graphql:generate`
  regenerates it and the drift check (`scripts/check-drift.mjs`) fails when it is stale.
- **Not yet:** the domain schema (feature epics add resolvers).

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
  from the request context (`bindTenant`); none means `403 tenant_context_missing`, never a shared key. The raw
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

`/internal/broker/runs/{runId}/{candidates|evidence|journal|tool-audit|state}` is mounted by `registerBrokerRoutes`
(`src/broker`), outside `/v1` and outside the public OpenAPI document (`brokerOpenApiDocument()` is its own
internal spec). Per request, in order: source guard (socket CIDR in `BROKER_ALLOWED_CIDRS` AND the mesh
identity header in `BROKER_MESH_IDENTITIES`; `X-Forwarded-For` is never trusted; anything missing refuses with
403), `Authorization: Bearer bwrun_...` token (401), revocation, per-run-session rate limit (429), then scope,
path/body run binding (403, never revealing other runs), body validation (422), a second revocation check, the
tenant-scoped run lookup and the run state (`409 run_not_active` for writes on a terminal run). Valid calls
answer `501 not_implemented` until FINDING, EVIDENCE, REVERSAL and ORCH implement them. Tokens are minted by
`signBrokerToken` (issuance wiring: RUNTIME/SANDBOX). Metrics: `broker_requests_total`,
`broker_auth_failures_total`. In-memory stores are offline stubs (online-porting #895).

## Authentication (#335)

One global guard, `AuthGuard` (`src/auth/guard.ts`, `APP_GUARD`), authenticates every route not marked `@PublicRoute()`
before the tenant guard runs. It picks exactly one validator by credential shape (`src/auth/credentials.ts`):

| Shape | Validator | Notes |
|---|---|---|
| `Authorization: Bearer bw_pat_…` / `bw_ci_…` | `BearerTokenValidator` (RBAC-007) | Delegated. Until RBAC-007 is wired, refused. The guard never hashes or looks up `api_tokens`. |
| `Authorization: Bearer <JWT>` | `createKeycloakJwtValidator` | Signature via cached JWKS (`src/auth/jwks.ts`), `iss`, `aud` (`API_JWT_AUDIENCE`), `exp`/`nbf`/`iat` with `API_JWT_LEEWAY_SECONDS`. RS256 and ES256 only. |
| `__Host-bw_session` cookie (no `Authorization`) | `createSessionCookieValidator` | Opens the BFF's sealed session id and reads its record from Valkey (same keys as `apps/web`). |

A malformed `Authorization` header is refused and never falls through to the cookie. The validators attach one
`Principal` (`@blackwing/contracts`), which `TenantContextGuard` reads for the tenant. Refusals are problem+json with
`auth_no_credentials`, `auth_invalid_token` or `auth_expired` (`401`), and a Valkey outage is `503`. Metrics:
`auth_validate_total{path,result}` and `jwks_refetch_total`. Tokens and cookies are never logged.

Configuration: `KEYCLOAK_ISSUER_URL` (unset refuses JWTs), `API_JWT_AUDIENCE`, `API_JWT_LEEWAY_SECONDS`,
`API_JWKS_TTL_MS`, `API_JWKS_REFETCH_COOLDOWN_MS`, `API_JWKS_TIMEOUT_MS`, and `BW_WEB_SESSION_SECRET` (plus `_PREVIOUS`).
The process entry point connects no Valkey client yet, so BFF session cookies stay refused there until the session store
is wired (`runApi({ sessionValkey })`); the validator and its tests are complete.

## Tenant context (TENANT-003)

Every route is tenant-scoped unless marked `@PublicRoute()` (probes, the banner). `TenantContextGuard` asks the
`tenantPrincipalSource` (IAM's validated principal: session claim or `bw_pat_`/`bw_ci_` binding) and resolves exactly
one tenant with `resolveTenantContext` from `@blackwing/db/tenant-context`; `TenantContextInterceptor` then runs the
handler inside the `AsyncLocalStorage` scope that repositories read (`getTenantContextOrThrow`). No principal is
`401`; a missing, malformed or ambiguous tenant is `403 tenant_context_missing`. A tenant in a body, query or header
is never read. The Run Broker runs each request in its run token's tenant and answers `403 cross_tenant_denied`
(audited as `tenant.cross_tenant_denied`) when a body or run record names another tenant. Worker activities get the
same context from `createTenantActivityInterceptors` (`apps/worker/src/tenant`), which re-reads the run's tenant on
every attempt. Metrics: `bw_tenant_context_missing_total`, `bw_cross_tenant_denied_total`.

## Rate limiting (CONTEXT_PACK §9, §8 #6)

`src/rate-limit/` is the API's only rate limiter. `RateLimitGuard` is a global guard mounted after the tenant guard,
so every tenant-scoped request is keyed by its resolved principal. Each request is charged against its buckets and
must be admitted by all of them (the stricter wins):

- Authenticated: the principal bucket `rl:{tenantId}:{tokenOrUserId}:{routeClass}` and the tenant ceiling
  `rl:{tenantId}:_tenant:{routeClass}`.
- Unauthenticated (public routes such as login): the client IP bucket `rl:_anon:ip:{ip}:{routeClass}`. The IP is
  honoured from `X-Forwarded-For` only behind a trusted proxy (`API_TRUST_PROXY`).
- Authentication runs first: an unauthenticated tenant route is `401` and charges nothing.

Limit values: `RateLimitConfig.limitsFor({scope, routeClass, tenantId})` supplies per-plan and per-route-class values
(TENANT-011). When it returns nothing, `RATE_LIMIT_DEFAULT_RPS` (10) and `RATE_LIMIT_BURST` (20) apply. `@RateLimit({
routeClass, rps, burst })` overrides the principal or IP limit of one route; `@RateLimitExempt()` marks health probes.

- Algorithm: a token bucket (refill at `rps`, capacity `burst`). A denied check consumes nothing. `Retry-After` is the
  whole seconds until the next token; `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` are sent on every
  response. A refusal is `429 rate_limited` (problem+json).
- Shared state: `ValkeyRateLimiter(client)` runs one Lua script per check. It reads the Valkey server clock (`TIME`),
  refills, and charges every bucket in one atomic step, so a concurrent burst admits no more than `burst` plus the
  refill. Keys carry a TTL, so idle buckets expire.
- Outage: if the shared limiter fails, the check is decided by the in-process limiter (same arithmetic, per instance)
  and `rate_limit.degraded` is logged; the API keeps serving and keeps limiting. The in-process limiter caps its
  bucket map and refuses a new key at the cap rather than evicting busy buckets.
- Metrics: `rate_limit_blocked_total{routeClass,scope}`, `rate_limit_degraded_total`,
  `rate_limit_check_duration_seconds`. The blocked log line `rate_limit.blocked` carries `rl.tenant` (hashed),
  `rl.principal`, `rl.routeClass`, `rl.remaining` and `rl.scope`, never a token.
- Wiring: `createApiApp({ rateLimiter, rateLimitConfig })` takes the shared limiter and the per-plan config. Without a
  limiter every instance uses the in-process one. The Valkey client is wired into the process entry point with the
  API's connection setup, as for the idempotency store.
