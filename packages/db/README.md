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
