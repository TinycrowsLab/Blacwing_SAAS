# Database migrations

How schema changes reach Postgres (DB-002, #69; CONTEXT_PACK §5 "SQL migrations committed and reviewed;
forward-only in prod", §7 "migrations run as a separate owner role").

## Workflow

1. Change the Drizzle schema in `packages/db/src/schema/**`.
2. `pnpm db:generate` (drizzle-kit, config `packages/db/src/drizzle.config.ts`) writes a timestamped
   `packages/db/migrations/<yyyymmddhhmmss>_<name>.sql`, its snapshot under `migrations/meta/` and a journal entry.
   No database is needed.
3. Review the SQL. Hand-written additions (FORCE ROW LEVEL SECURITY, grants, RLS policies from DB-003) go at the
   end of the generated file under a `-- Hand-written below` comment. Never put credentials in SQL.
4. `pnpm db:check` (needs Docker) and commit the SQL, snapshot and journal together. The PR review covers the SQL.
5. `pnpm db:migrate` applies pending migrations to the database in `.env` (`PG*` and `PG_OWNER_*`).

Applied migrations are immutable: fix a mistake with a new migration. The `drift` workflow rejects edits to
migrations that exist on the base branch (see [drift-checks.md](drift-checks.md)).

## The runner (`pnpm db:migrate`)

`packages/db/src/migrate-main.ts` connects with the owner pool (`@blackwing/db/owner`, role `bw_owner`) and calls
`migrateDatabase`:

- every pending migration runs in **one transaction** under an advisory lock, so a crash or a failing statement
  leaves the database at the previous version and two concurrent deploys cannot interleave;
- applied versions are recorded in `drizzle.__drizzle_migrations` (drizzle-kit's table and format);
- logs `db.migrate.start`, then `db.migrate.skipped {version}` or `db.migrate.applied {version, durationMs}` per
  migration and `db.migrate.done`. No connection details or data are logged;
- re-running is a no-op;
- the runtime role `bw_app` cannot migrate: it lacks the privileges and the run fails with `42501`.

Statements that cannot run inside a transaction are not allowed (`CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`,
`ALTER SYSTEM`). Statements that are not rolled back cleanly everywhere must be idempotent:
`CREATE EXTENSION IF NOT EXISTS`, `ALTER TYPE ... ADD VALUE IF NOT EXISTS`. `pnpm db:check` enforces both.

## Forward-only in production

With `NODE_ENV=production` the runner refuses, before applying anything:

- an up migration containing a destructive statement: `DROP TABLE|SCHEMA|DATABASE|TYPE|DOMAIN|SEQUENCE|EXTENSION|
  COLUMN|OWNED|MATERIALIZED VIEW`, `TRUNCATE`, `DELETE FROM`, or an RLS-weakening statement
  (`DISABLE`/`NO FORCE ROW LEVEL SECURITY`, `BYPASSRLS`);
- any down migration (`pnpm db:migrate:down`).

A reviewed exception needs `ALLOW_DESTRUCTIVE_MIGRATION=1` (exactly `1`; unset by default) on that one run.
Prefer expand/contract: add the new shape, migrate the data, drop the old shape in a later release.

`packages/db/migrations/down/<tag>.sql` holds optional, **dev-only** down migrations. `pnpm db:migrate:down`
reverts the latest applied migration with its down file and removes its record.

## Drift check (`pnpm db:check`, CI job `db-drift`)

`packages/db/src/check/drift.int.test.ts`, run on every PR by the `db-drift` job in `.github/workflows/drift.yml`:

| Check | Fails when |
|---|---|
| Journal | Journal indexes are not contiguous; two migrations share a prefix; a migration is not newer than the one before it; snapshots fork (two share a parent); a `.sql` file is missing from the journal; the SQL lint above fails |
| Schema vs migrations | `drizzle-kit generate`, run on a temporary copy of `migrations/`, would emit a migration (a schema edit without its committed migration) |
| Migrations vs snapshot | A scratch Postgres 16 + pgvector (Testcontainers, image pinned by digest in `infra/images.lock`) built from the migrations differs from the latest snapshot: tables, columns and types, nullability, indexes, constraints, policies, RLS, enums |
| Idempotency | Re-running the migrations on that database applies anything |

On failure the job uploads `db-drift.md` (the missing SQL or the catalogue diff, `-` snapshot only, `+` database
only) as the `db-drift` artifact and adds it to the step summary.

### Two PRs added migrations at once

The second PR to merge fails `db-drift` with a journal problem ("share the prefix", "same parent" or "not newer
than"). Fix: rebase on `main`, delete your generated migration (its `.sql`, its `meta/<prefix>_snapshot.json`
and its journal entry), run `pnpm db:generate` again and commit the result. Do not rename files by hand: the
snapshot chain and the journal timestamps must stay consistent.

## Deploy

The `migrate` workflow (`.github/workflows/migrate.yml`) runs `pnpm db:migrate` with `NODE_ENV=production` before
a rollout, with owner credentials loaded from the secret store at run time. It is gated off until the online
environment exists (online-porting #893); the deploy pipeline then also emits the config-change audit event.
