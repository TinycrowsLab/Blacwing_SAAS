# Tenant data access

Tenant isolation is enforced at the data-access choke point (CONTEXT_PACK §7, §8.6, §8.11).
Row-level security (DB-003) is the last line of defence; these guards stop a bypass earlier.

## Rules

1. Every tenant-scoped repository gets its data access through `withTenant` (`packages/db/src/with-tenant.ts`,
   the single implementation) and types its handle as `TenantScopedDb`.
2. The raw `db` or pool is reserved for tables without a `tenant_id` column (for example `users`),
   for `withSystem`, and for migrations.
3. Call `assertTenantScope(tx, expectedTenantId?)` in a repository that wants a cheap paranoia check.
   It throws `TenantContextMissingError` (`TENANT_CONTEXT_MISSING`) when no context is set and
   `TenantContextMismatchError` (`TENANT_CONTEXT_CONFLICT`) for a different tenant. It never sets context.

## The three layers

| Layer | Mechanism | Where |
| --- | --- | --- |
| Compile time | `TenantScopedDb` (alias of the `TenantTx` brand that only `withTenant` attaches). A raw `Database`, pool or `withSystem` handle does not compile. | `packages/db/src/tenant-scope.ts` |
| Lint time | ESLint rule `blackwing/no-raw-tenant-db`: a query on a table that carries `tenant_id` through a raw `db` or pool is an error. | `scripts/eslint-rules/` |
| Run time | `assertTenantScope`, backed by RLS. | `packages/db/src/tenant-scope.ts` |

## Opting out

Migrations, the owner pool and `withSystem` code opt out per query with an explicit annotation that
needs a reason: `// blackwing:allow-raw-tenant-db <reason>`. Do not turn the rule off.

## Limits

The rule resolves queries statically. A dynamically constructed query is not seen by the linter;
`assertTenantScope` and RLS are the runtime backstop. A new tenant table without the `tenant_id`
column mixin is caught by the TENANT-009 meta-test over `tenant_id` columns.

New files under `packages/db/src` are reviewed by the security owners (`.github/CODEOWNERS`).
