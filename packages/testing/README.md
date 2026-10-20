# @blackwing/testing

Shared test tooling (CONTEXT_PACK §5: Vitest for unit tests, Testcontainers for integration tests, fast-check
for property tests). It makes the §8.6 tenant-isolation test the cheap default for every data module.

| Entry point | Holds | Needs Docker |
|---|---|---|
| `@blackwing/testing` | Factories, `FixedClock` (from `@blackwing/time`), fast-check arbitraries, `crossTenantDenied` | no |
| `@blackwing/testing/containers` | `withPostgres`, `withValkey`, `withMinio`, `withNeo4j`, `withTenant`, `runForTenant` | yes |
| `@blackwing/testing/vitest` | `useFixedClock`, `surfaceContainerLogsOnFailure` (test files only) | no |
| `@blackwing/testing/vitest-config` | `defineUnitConfig`, `defineIntegrationConfig` (config files only) | no |
| `@blackwing/testing/sql/*` | The reusable RLS role setup (`rls-roles.sql`, `rls-database.sql`) | n/a |

## Test layout

Unit tests are `src/**/*.test.ts` and never need Docker. Integration tests are `src/**/*.int.test.ts` and run only
under `pnpm test:int`. A member opts in with two config files under `src/` (so its tsconfig typechecks and
lints them) and two scripts:

```ts
// src/vitest.config.ts, with "test": "vitest run --config src/vitest.config.ts"
import { defineUnitConfig } from '@blackwing/testing/vitest-config';
export default defineUnitConfig();

// src/vitest.int.config.ts, with "test:int": "vitest run --config src/vitest.int.config.ts"
import { defineIntegrationConfig } from '@blackwing/testing/vitest-config';
export default defineIntegrationConfig();
```

Both presets pin `TZ=UTC` and restore mocks. The integration preset sets long timeouts, at most two workers
and no retries (retries would hide flaky isolation bugs; container boot has its own wait-for-ready timeout).

## Factories

```ts
import { createFactories, makeRun } from '@blackwing/testing';

const f = createFactories({ seed: 42 });               // deterministic: same seed, same entities
const tenant = f.makeTenant();
const asset = f.makeAsset({ tenantId: tenant.id });    // override only what the test asserts
const run = makeRun({ tenantId: tenant.id });           // module-level helpers share one seeded set
```

`makeTenant`, `makeUser`, `makeAsset`, `makeStandingAuthorisation`, `makeRun`, `makeTestCase` and `makeFinding`
return entities that are valid by default. Ids are UUIDv7 from `@blackwing/ids` (`createUuidV7Generator` fed by
the seed and the clock) and timestamps are `Z`-suffixed ISO strings from a `FixedClock`. Every result is parsed
by its `@blackwing/contracts` schema, so an override that breaks a contract rule (requester = approver, a
destructive SA, a paused run without a reason) throws a `ZodError`. For deliberately invalid input, spread a
valid entity into a plain object. Fixtures only use reserved names (`example.test`, RFC 2606) and placeholder
signatures, never real key material.

`tenantArbitrary()`, `runArbitrary()` and the other arbitraries generate valid entities for property tests.
`tenantIdPairArbitrary()` yields two distinct tenant ids.

## Time

`FixedClock` and `Clock` are re-exported from `@blackwing/time`. Factories take any `Clock` (default: a
`FixedClock` at `DEFAULT_TEST_EPOCH`, `2026-01-01T00:00:00.000Z`). `useFixedClock(start)` in a test file returns
a `FixedClock` that also drives `Date` and `Date.now()` (`clock.advance('5m')` moves both). Only `Date` is faked,
so timers and I/O keep working; the clock resets before each test and real time is restored after it.

## Tenant isolation (§8.6)

```ts
import { crossTenantDenied } from '@blackwing/testing';
import { withPostgres } from '@blackwing/testing/containers';

const db = await withPostgres({ migrations: "path/to/migrations" });
await crossTenantDenied(
  (tenantId) => db.withTenant(tenantId, (tx) => tx.query("SELECT * FROM assets WHERE id = $1", [assetId])),
  { ownerTenantId: tenantA.id, otherTenantId: tenantB.id, subject: "asset row" },
);
```

`crossTenantDenied(read, …)` first proves that the owner's read succeeds and returns data, then that the other
tenant gets an empty result or a denial error (`42501`, `NOT_FOUND`, `FORBIDDEN`, `TENANT_ACCESS_DENIED`, HTTP
403/404). Checking only the denial is a false negative waiting to happen: a broken query also returns nothing.
It works for any data path (SQL, a repository, the Neo4j guard, an HTTP call).

## Containers

Every helper starts a digest-pinned image (`TEST_IMAGES`) on random host ports, waits for readiness with a
timeout (default 120 s) and returns a handle with `stop()` (call it in `afterAll`) and `logs()`. A container
that never becomes ready raises `ContainerStartError` with its recent output. `surfaceContainerLogsOnFailure(() =>
[db])` prints logs when a test fails. Without Docker, helpers throw `DockerUnavailableError` with what to do.

| Helper | Gives you |
|---|---|
| `withPostgres({ migrations })` | Postgres 16 + pgvector + pgcrypto. As the superuser it runs `sql/rls-roles.sql` (roles `bw_owner` and `bw_app`, neither SUPERUSER nor BYPASSRLS), creates a database for this call owned by `bw_owner` and runs `sql/rls-database.sql`. It then applies the migrations as `bw_owner` (a directory of `*.sql` files in name order, or a runner function) and refuses to continue if `bw_app` could bypass RLS. Returns `appPool` (`bw_app`), `ownerPool`, `withTenant(tenantId, fn)` and `connectionConfig(role)`. |
| `withValkey()` | Valkey 8 with a password, an ioredis client with a per-call `keyPrefix`, and `createClient()`. |
| `withMinio()` | MinIO with an Object Lock bucket for this call (optional default retention) and an AWS SDK v3 `S3Client`. |
| `withNeo4j()` | Neo4j 5 Community, a driver, and `runForTenant(tenantId, cypher, params)`: the test-side tenantId guard, which refuses queries that do not filter on `$tenantId`. |

`withTenant(db, tenantId, fn)` mirrors the production helper (§7). It runs `BEGIN`, then
`set_config('app.tenant_id', $1, true)` (the bindable form of `SET LOCAL`), then `fn`, then `COMMIT`, or
`ROLLBACK` if anything throws. A missing or malformed tenant id throws `TenantContextError` before any query runs.
A query outside `withTenant` errors out on RLS tables, so a missing context fails closed.

### Reuse

Containers are shared by the tests of one file (start in `beforeAll`, stop in `afterAll`). Reuse across runs is
off by default, because the dev host is shared and a reused container outlives the test process. To turn it on
in dev, set `BW_TESTCONTAINERS_REUSE=true` or pass `reuse: true`. In CI (`CI` set) reuse is always off, and so
is every run with `TESTCONTAINERS_REUSE_ENABLE=false`. Reuse is safe because each call isolates itself: its own
database, bucket or key prefix, and Neo4j cleanup by tenant. Reused containers get credentials derived from a
per-developer secret at `~/.cache/blackwing/testcontainers.secret` (mode 0600, created on first use). Throwaway
containers get fresh random credentials. Find leftovers with `docker ps --filter label=org.blackwing.testing.service`.

### Images

| Service | Image |
|---|---|
| Postgres | `pgvector/pgvector:0.8.1-pg16` |
| Valkey | `valkey/valkey:8.1.4-alpine` |
| MinIO | `cgr.dev/chainguard/minio` (a source build of upstream MinIO; upstream no longer publishes `minio/minio` images on Docker Hub) |
| Neo4j | `neo4j:5.26.12-community` |

Digests are in `src/containers/images.ts`. The dev compose stack (DEVENV) must use the same references.
