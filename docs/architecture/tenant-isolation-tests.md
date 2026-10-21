# Cross-tenant isolation tests (TENANT-003)

CONTEXT_PACK §8 #6 requires cross-tenant tests for every data-access module. The reusable harness
lives in `@blackwing/testing/containers` (`src/containers/tenant-isolation.ts`) and runs on the
Testcontainers Postgres of `withPostgres`, with the real migrations applied as `bw_owner` and every
assertion executed as `bw_app`. An assertion refuses a pool that is not `bw_app`.

| Assertion | Proves |
| --- | --- |
| `expectRlsBlocksCrossTenant(appPool, table, { tenantA, tenantB, insertRow })` | the owner reads its own row (no false negative); the other tenant reads nothing; cross-tenant UPDATE/DELETE touch nothing; INSERT and tenant-moving UPDATE are rejected (42501). |
| `expectFailsClosedWithoutContext(appPool, table)` | with `app.tenant_id` unset or empty the query **raises**. This is the canary for a `current_setting('app.tenant_id', true)` regression. |
| `expectNoLeakAcrossTransactions(appPool, a, b)` | a reused pooled connection never carries a tenant context into the next transaction. |
| `expectAppRoleCannotBypass(appPool)` | `bw_app` has no BYPASSRLS, is not a superuser, cannot `SET ROLE`, `ALTER ROLE` or run DDL. |
| `expectAllTenantTablesForceRls(ownerPool)` | every table with a `tenant_id` column has RLS enabled **and** forced, and at least one policy. |
| `expectEveryTenantTableCovered(ownerPool, tables)` | every tenant table is listed in the suite, so a new one fails CI until it gets tests. |

## Running

`pnpm test:isolation` runs `packages/db/src/tenant-isolation.int.test.ts` (needs Docker). The CI job
`isolation` in `.github/workflows/test.yml` runs it on every pull request; it is a required check in
`.github/rulesets/main.json`. The JUnit report is uploaded as the `isolation-report` artifact, and the
per-table test names are the coverage note of which tables have isolation tests.

## Adding a tenant table or data-access package

1. Add the table to `ISOLATION_TABLES` in `tenant-isolation.int.test.ts` with a seeder that inserts one
   valid row for a given tenant. The coverage meta-test fails until you do.
2. In a new data-access package, import the assertions in its own `*.int.test.ts` and call them with
   `handle.appPool` for each table it owns.
3. Never run isolation tests as `bw_owner` or a superuser, and never assert only the denial: the
   helpers seed a row first so an empty result cannot be a broken query.

The suite also tests itself: the `negative` block builds tables with the fail-open policy form, without
RLS, without FORCE and without WITH CHECK, and requires the assertions to fail.

`tenants` and `memberships` (TENANT-001) are not in the schema yet; they join `ISOLATION_TABLES` the
moment their migration lands (the coverage meta-test enforces it).
