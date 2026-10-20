# Drift checks

The `drift` workflow (`.github/workflows/drift.yml`, CI-015) keeps generated contracts and the database in
lockstep with code. It runs on every pull request and on `main`, with `contents: read` and a throwaway
Postgres service container. `TZ=UTC` and `LANG=C.UTF-8` are pinned so generation is deterministic.

## What it checks

| Check | Fails when | Fix |
|---|---|---|
| OpenAPI 3.1 | `pnpm openapi:generate` changes `apps/api/openapi/` | Run `pnpm openapi:generate`, commit |
| GraphQL SDL | `pnpm graphql:generate` changes `apps/api/graphql/` | Run `pnpm graphql:generate`, commit |
| Schema vs migrations | `pnpm db:generate` (drizzle-kit generate) emits a new file in `packages/db/migrations/` | Review and commit the generated migration |
| Forward-only | A migration file that exists on the base branch is modified or deleted | Add a new migration instead |
| Fresh apply | Any migration fails on a fresh pgvector Postgres 16 (`psql -v ON_ERROR_STOP=1`) | Fix the migration (before it is merged) |

Generators are the `openapi:generate`, `graphql:generate` and `db:generate` scripts of workspace members
(`pnpm -r --if-present`), so each owning epic (API, DB) adds its script and the artifact paths listed in
`scripts/check-drift.mjs` (`ARTIFACTS`). Generated files are formatted with Prettier before the diff; generators
must sort keys and lists so output is stable.

Failures name the stale artifact and the command to run, in the job log and the step summary.

## Baseline squash

Squashing the migration history is a deliberate, reviewed exception. Add the `migration-squash` label to the
pull request; the forward-only check is then skipped for that PR. Do not use the label for anything else, and
never squash after a migration has been applied to a shared or production database.

## Local run

```sh
pnpm openapi:generate && pnpm graphql:generate && pnpm db:generate
node scripts/check-drift.mjs stale
node scripts/check-drift.mjs immutable origin/main
DATABASE_URL=postgres://... node scripts/check-drift.mjs apply
```
