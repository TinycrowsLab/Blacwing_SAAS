# @blackwing/db

Drizzle schema, SQL migrations and tenant-scoped (RLS) data access. See
[CONTEXT_PACK §7](../../docs/architecture/CONTEXT_PACK.md) and ADR 0010.

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
