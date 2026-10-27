// Hermetic Postgres for the DB integration suites (issue #76, CONTEXT_PACK §5, §8.6).
//
// Each call starts its own Postgres 16 + pgvector container (or, with the dev reuse opt-in, its own
// database on a shared one), applies the REAL migrations as bw_owner, verifies that every tenant table
// has FORCE RLS, and returns pools for bw_app (RLS applies) and bw_owner (fixtures only). No superuser
// shortcut: the app role is checked by withPostgres, and tests run as bw_app.
//
// Test code only: it starts containers, so import it from *.int.test.ts files (see
// docs/architecture/dependency-graph.md, "Test code may also import @blackwing/testing").
//
// Startup budget: one container boot (pgvector image, pinned by digest, cached after the first pull)
// plus the migrations. The boot is gated on the ready log line and `pingPool`, so a test never races
// a half-started server. Container logs and migration durations are logged at debug.

import { createLogger } from '@blackwing/logger';
import {
  expectAllTenantTablesForceRls,
  listTenantTables,
  type PostgresHandle,
  withPostgres,
} from '@blackwing/testing/containers';

import { pingPool } from '../../client.js';
import { migrateDatabase } from '../../migrate.js';

import type pg from 'pg';

const logger = createLogger('@blackwing/db:testing');

/** Ledger tables whose BEFORE TRUNCATE trigger refuses truncation (TRIGGER_TYPE_TRUNCATE). */
const TRUNCATE_TRIGGER_TYPE_BIT = 32;

/** Fixture rows, run as bw_owner inside one transaction. Insert tenant data, or make it idempotent. */
export type TestSeed = (owner: pg.ClientBase) => Promise<void>;

/** Options for {@link startTestDatabase}. */
export interface StartTestDatabaseOptions {
  /** Runs after the migrations, and again after every {@link TestDatabase.reset}. */
  readonly seed?: TestSeed;
}

/** A migrated, RLS-verified test database. */
export interface TestDatabase extends PostgresHandle {
  /**
   * Returns every tenant table to the seeded baseline: truncates them (schema, roles and policies are
   * kept) and runs the seed again, all in one transaction. Append-only ledgers are cleared too: their
   * truncate guard is disabled for this transaction only, so a failed reset leaves the guard in place.
   */
  reset(): Promise<void>;
  /** `withTenant` on the bw_app pool: `SET LOCAL app.tenant_id` for the duration of `fn`. */
  withTestTenant<T>(tenantId: string, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
}

/** Quotes a table name. Names come from the catalogue, never from callers. */
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Tenant tables that carry a BEFORE TRUNCATE trigger (the append-only ledgers). */
async function truncateGuardedTables(owner: pg.Pool, tables: readonly string[]): Promise<string[]> {
  if (tables.length === 0) return [];
  const { rows } = await owner.query<{ t: string }>(
    `SELECT DISTINCT c.relname AS t
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT tg.tgisinternal
        AND (tg.tgtype & $1) <> 0 AND c.relname = ANY($2)
      ORDER BY c.relname`,
    [TRUNCATE_TRIGGER_TYPE_BIT, [...tables]],
  );
  return rows.map((row) => row.t);
}

/**
 * Truncates every tenant table on `owner` and runs `seed`, atomically. Exported for the unit tests;
 * tests use {@link TestDatabase.reset}.
 */
export async function resetTestDatabase(owner: pg.Pool, seed?: TestSeed): Promise<void> {
  const tables = await listTenantTables(owner);
  const guarded = await truncateGuardedTables(owner, tables);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const table of guarded) {
      await client.query(`ALTER TABLE ${ident(table)} DISABLE TRIGGER USER`);
    }
    if (tables.length > 0) {
      await client.query(`TRUNCATE ${tables.map((table) => ident(table)).join(', ')} CASCADE`);
    }
    for (const table of guarded) {
      await client.query(`ALTER TABLE ${ident(table)} ENABLE TRIGGER USER`);
    }
    if (seed !== undefined) await seed(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Starts a Postgres container, applies the committed migrations as bw_owner, verifies FORCE RLS on
 * every tenant table, checks the app role is reachable, then runs the seed. Throws (and stops the
 * container) if any step fails, so a test never runs against a half-prepared database.
 */
export async function startTestDatabase(
  options: StartTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const db = await withPostgres({
    migrations: (owner) => migrateDatabase(owner, logger).then(() => undefined),
  });
  logger.debug({ containerId: db.containerId, port: db.port, reused: db.reused }, 'testdb.started');
  try {
    const health = await pingPool(db.appPool);
    if (!health.ok) throw new Error('test database is not ready: the bw_app ping failed');
    const tables = await expectAllTenantTablesForceRls(db.ownerPool);
    logger.debug({ tenantTables: tables.length }, 'testdb.rls-forced');
    if (options.seed !== undefined) {
      const seed = options.seed;
      await withOwnerTransaction(db.ownerPool, seed);
    }
  } catch (error) {
    await db.stop();
    throw error;
  }
  return {
    ...db,
    reset: () => resetTestDatabase(db.ownerPool, options.seed),
    withTestTenant: (tenantId, fn) => db.withTenant(tenantId, fn),
  };
}

async function withOwnerTransaction(owner: pg.Pool, seed: TestSeed): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await seed(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
