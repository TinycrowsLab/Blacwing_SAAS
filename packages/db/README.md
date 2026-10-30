# @blackwing/db

Drizzle schema, SQL migrations and tenant-scoped (RLS) data access. See
[CONTEXT_PACK §7](../../docs/architecture/CONTEXT_PACK.md) and ADR 0010.

## `withTenant` and `withSystem` (DB-004)

`src/with-tenant.ts` is the only implementation of the tenant transaction doorway.

- `withTenant(db, tenantId, fn, options?)` opens the transaction (`BEGIN`), runs a bound,
  transaction-local `set_config('app.tenant_id', $1, true)`, calls `fn(tx)` and commits (rolls back
  on a throw). A missing id throws `TenantContextMissingError` (`meta.reason: 'missing'`), a non-UUID
  the same error (`'invalid_uuid'`), both before any query.
- `40001` and `40P01` re-run the whole transaction up to `DB_TX_MAX_RETRIES` (default 3) with
  jittered backoff, then throw `TxRetryExhaustedError` (`TX_RETRY_EXHAUSTED`, 503). `fn` can run more
  than once: keep it idempotent and do database work only. `DB_TX_ISOLATION` (`read committed`
  default, `repeatable read`, `serializable`) sets the level; `options.isolation` overrides it.
- A nested call for the same tenant reuses the open transaction; a different tenant (or `withSystem`
  inside `withTenant`) throws `TenantContextMismatchError` (`TENANT_CONTEXT_CONFLICT`).
- `options.signal` (kill switch) is checked before BEGIN, before each retry and before COMMIT: an
  aborted transaction never commits.
- `withSystem(db, fn, { audit, actor, reason })` is the explicit, audited bypass for platform
  maintenance. It sets no tenant, so RLS keeps tenant tables closed to it.
- Queries on another client or pool inside `fn` run outside the transaction and are unsupported.

## The tenant choke point (TENANT-002)

Tenant tables are reached only through `withTenant`. Type repository handles as `TenantScopedDb`,
let the `blackwing/no-raw-tenant-db` lint rule catch raw `db` or pool queries, and call
`assertTenantScope` for a runtime check. See `docs/architecture/tenant-data-access.md` and the
CODEOWNERS entry for `packages/db/src/**`.

## The repository pattern (DB-007)

Every domain module reads and writes through a repository built on `BaseRepository`
(`src/repository.ts`). It is thin on purpose: compose it, do not build a class hierarchy.

| Rule | How it is enforced |
| --- | --- |
| Tenant isolation (§8.6) | Every method runs through `withTenant` with the ambient tenant. No tenant means `TenantContextMissingError`. There is no raw pool access in domain code. |
| Optimistic concurrency (§9) | `update(id, expectedStateVersion, changes)` writes `WHERE state_version = $expected` and increments it. A mismatch is `ConcurrencyError` (code `PRECONDITION_FAILED`, HTTP 412). A missing, deleted or foreign row is `NotFoundError`. |
| Pagination | `list({ cursor, limit, includeDeleted })`: keyset on `(created_at, id)`, `limit` defaults to 50 and above 200 is rejected, returns `{ items, nextCursor }` (`nextCursor` is `null` on the last page, and an empty set is `{ items: [], nextCursor: null }`). Cursors are opaque base64url; a malformed one is `CursorInvalidError` (reason `cursor_invalid`). `created_at` is compared at millisecond precision, the precision a cursor carries. |
| Input validation | Create and update inputs are parsed with the Zod schemas you pass in. `id`, `tenantId`, `stateVersion` and `deletedAt` are never writable, whatever the schema accepts. Error details name fields, never values. |
| Soft delete | `softDelete(id)` sets `deleted_at` and bumps `state_version`. Reads exclude deleted rows; `includeDeleted: true` opts in (`findById(id, { includeDeleted })`, `list({ includeDeleted })`). `delete(id)` removes the row for good. |
| Foreign keys | A foreign key violation (for example deleting a referenced row) is `ForeignKeyError` (HTTP 409) with the constraint name. Use composite `(tenant_id, parent_id)` foreign keys so a row cannot point into another tenant: plain FK checks bypass RLS. |
| Audit (§8.8) | Pass `audit: (event, tx) => ...`. It runs inside the mutation's transaction for `create`, `update`, `soft_delete` and `delete`, with `{ entity, op, tenantId, id, stateVersion }`. If it throws, the mutation rolls back. |
| Observability | Each method runs in a span `repo.<entity>.<op>` (pass a `tracer`) and logs `{ entity, op, tenantId, rowCount }` (pass a `logger`). Row contents are never logged. |

### Writing a repository

1. Build the table from the DB-004 mixins (`idColumn`, `tenantIdColumn`, `timestamps`, `stateVersion`,
   `softDelete`), add `tenantIdIndex`, and give it the tenant policy in its migration with `rlsPolicySql`.
   `src/examples/widget.table.ts` is the reference.
2. Write the Zod schemas of its writes and extend the base, as in `src/examples/widget.repository.ts`:

   ```ts
   export class WidgetRepository extends BaseRepository<typeof widgets, WidgetCreate, WidgetUpdate> {
     constructor(options: WidgetRepositoryOptions) {
       super({ ...options, entity: 'widget', table: widgets, createSchema, updateSchema });
     }
   }
   ```

3. Domain-specific queries go through the protected `run(op, (tx, tenantId) => ...)`, which gives them the
   tenant transaction, the span and the log line.
4. Copy `src/examples/widget.cross-tenant.int.test.ts` for the new repository. It is the cross-tenant
   template the Definition of Done refers to: tenant B must not read, list, update, delete or reference
   tenant A's rows, and a missing tenant context must fail closed. Integration tests run with
   `pnpm test:int` (Docker/Testcontainers).

The ambient tenant is supplied as a function (`tenant: () => string | undefined`); request-scoped
propagation (TENANT-003) provides the real source. The `widget` table lives under `src/examples` only: it
is not in `schema/index.ts` and has no migration.

## Hermetic test database (#76)

`startTestDatabase({ seed })` in `src/testing/testdata/pg-container.ts` starts a `pgvector/pgvector:0.8.1-pg16`
container (pinned by digest in `@blackwing/testing`), applies the committed migrations as `bw_owner`, checks that
every tenant table has FORCE RLS, pings the `bw_app` pool and runs the seed. Each call gets its own uniquely named
database, so test files that run in parallel never share rows. Integration tests call `db.reset()` between tests to
return the tenant tables to the seeded baseline (the audit ledger's truncate guard stays enabled), and
`db.withTestTenant(id, fn)` runs a callback in a tenant transaction as `bw_app`. Measured startup is about 3 to 7 seconds
per call on a warm image cache (container boot plus migrations); keep a generous `beforeAll` timeout. The
meta-test is `src/testing/testdata/pg-container.int.test.ts`. Docker is required (`pnpm test:int`).

## Embeddings and pgvector (DB-005)

Migration `20261021081012_pgvector_pgcrypto` enables `vector` (pgvector) and `pgcrypto`. The vector
migration fails fast with guidance when the server does not ship pgvector. `src/vector.ts` holds the
conventions; MEMORY and knowledge tables build on them.

| Convention | How it is enforced |
| --- | --- |
| Embeddings are `vector(384)` (bge-small-en-v1.5) | `embeddingColumn(name = 'embedding')`. The database also rejects a wrong length. |
| The boundary validates the length | `parseEmbedding()` / `embeddingSchema` throw `ValidationError` `vector_dim_mismatch` (422) for a wrong length and `vector_invalid` for NaN, Infinity or a non-number. The detail never echoes the values. |
| HNSW indexes use cosine ops, `m = 16`, `ef_construction = 64` | `hnswIndex(tableName, column, { distance })`. `distance` is `cosine` (default) or `l2`, and each one pairs its operator class with its query operator (`VECTOR_DISTANCE`). |
| Queries use the matching operator (`<=>` cosine, `<->` L2) | `embeddingDistance(column, query, distance)`. The query vector is validated first. |
| `hnsw.ef_search` defaults to 40 | `hnswEfSearchSql(n)` returns `SET LOCAL hnsw.ef_search = n` (1 to 1000). Run it inside the tenant transaction, before the ANN query. |
| Embeddings are tenant data | An embedding table gets `tenantIdColumn`, `tenantIdIndex` and `rlsPolicySql`, like any tenant table. |
| pgcrypto is for non-secret hashing and UUID fallback only | Customer secrets stay in OpenBao (SECRETS), never in these tables in plaintext. |

Operational notes: a large HNSW build needs `maintenance_work_mem` headroom, so raise it for the session that
runs the migration. ANN queries show up in the slow-query log under `<=>` and `<->`. Metrics are deferred to
MEMORY. `CREATE EXTENSION` runs as its own statement in the migration with `IF NOT EXISTS`, so a re-run after a
partial apply is safe. The integration test for these helpers is `src/vector.int.test.ts` (Testcontainers).

## Test plans and test cases (PLAN-001)

`src/schema/test-plans.ts` holds `test_plans` (one row per plan version, `(run_id, version)` unique) and
`test_cases` (one row per proposed case, §7). `src/schema/runs.ts` is the minimal `runs` table they reference:
ORCH extends it, the test-plan tables do not change for that. `TestPlanRepository` (`src/test-plans.repository.ts`)
writes the next version with its cases in one transaction and reads plans back, through `withTenant`.

- Enums come from `@blackwing/contracts` (`TEST_PLAN_STATUSES`, `TEST_CASE_STATUSES`, `INTRUSIVENESS_CLASSES`,
  `RUN_STATES`), so the database and the contracts cannot drift (the schema unit test compares them).
- `destructive` is storable (provenance) but cannot be approved, executing or executed (CHECK, §8.3). The repository
  refuses to plan it at all, before any transaction.
- A case that is approved, executing or executed must carry its declared oracle (CHECK, §8.11).
- Size limit: the API layer (PLAN-005) caps `targets`, `budget`, `oracle` and `negative_control` at 16 KiB each.
  The migration's CHECK is a 64 KiB backstop, so an oversized value fails closed.
- Titles and refs are UTF-8 text with no truncation; the API enforces their length.
- Concurrent writers of one run race on `(run_id, version)`: the loser gets `ConcurrencyError` (412) and retries.

## Vulnerability-intelligence mirror (INTEL-001)

`src/schema/intel.ts` holds the local mirror that the ingestion jobs (INTEL-002..006) populate and the matcher and
enrichment read (INTEL-007, 009, 010). The shared values (OWASP schemes, sources, sync statuses, size caps) live in
`INTEL_LIMITS` in `@blackwing/contracts`, and the read-model schemas in `@blackwing/domain` (`intel/model.ts`).

| Table | Scope | Notes |
| --- | --- | --- |
| `cve_records` | reference | Keyed by `cve_id`. A CVSS block is `NULL` when the source publishes no vector. `cpe_matches` is capped at 64 KiB per record. |
| `kev_entries`, `epss_scores` | reference | CISA KEV and FIRST EPSS. Probabilities are CHECKed to `[0, 1]`. |
| `osv_advisories`, `cwe_catalogue` | reference | Package ranges and the CWE graph, as published, with byte caps. |
| `owasp_mappings` | reference | Keyed by `(scheme, code)`; `scheme` is `top10_2021` or `api_top10_2023`. |
| `source_sync_state` | reference | One row per source: incremental cursor, freshness and last error. |
| `finding_intel` | tenant | Forced RLS and a composite foreign key to `findings(tenant_id, id)`. The only tenant-scoped table here. |

- **Reference tables are read-only for `bw_app`.** The owner's default privileges grant DML on every new table, so the
  migration revokes it again. Writes come from the ingestion role, granted by its own migration. The mirror's own
  writer, `upsertCveRecords`, runs on the owner pool and parses every record with the domain schema first.
- **One row per CVE.** `upsertCveRecords` merges a batch to the newest record per `cve_id`, then upserts. A stored row is
  replaced only by an equal or newer `source_updated`, so re-running a sync is idempotent and never regresses.
- **Metric.** `createIntelMirrorRowsMetric(meter)` exports `intel_mirror_rows{table}`. `countIntelMirrorRows(db)` gives the
  counts that ingestion reports after each sync.
- The `finding_intel_finding_fk` foreign key is `NOT VALID`, for the same reason as `verification_challenges`: `findings` is
  FORCE RLS, so validating it as the owner is refused. Inserts are still checked by the referential-integrity trigger.

Tests: `src/intel-mirror.rls.int.test.ts` (Testcontainers: read-only reference tables, CHECK negatives, upsert rules,
tenant isolation of `finding_intel`) and `src/intel-mirror.metrics.test.ts`. The domain schemas are in
`packages/domain/src/intel/model.test.ts`.

## Cost ledger and price tables (COST-001)

Schema in `src/schema/cost.ts`; the migration is the `*_cost_ledger_price_tables` file in `migrations/`.

- `cost_ledger` is tenant data (RLS, FORCE). It is append-only for the runtime role: `bw_app` has `SELECT, INSERT`
  and no `UPDATE`, `DELETE` or `TRUNCATE`, so a correction is a compensating row. The unique key
  `(tenant_id, usage_event_id)` makes ingestion idempotent. Every row pins the `price_tables` row it was priced with.
- `price_tables` is platform reference data with no `tenant_id`. Tenants read it, `bw_app` cannot write it, and the
  `bw_operator` role is the only writer. Rows are unique on `(provider, model, version)`; a price change is a new version.
- Money is `numeric` (never float). The enums and the model-id rule (exact ids, no date suffix) come from
  `@blackwing/contracts` (`COST_PROVIDERS`, `COST_STAGES`, `costModelIdSchema`) and are also CHECK constraints.
- Ingestion (COST-002), pricing (COST-003) and aggregation (COST-004) are separate issues.
