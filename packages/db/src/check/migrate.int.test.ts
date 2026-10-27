// DB-002 integration: the migrate runner and the drift check against Postgres 16 + pgvector
// (Testcontainers). Fresh apply, idempotent re-run, crash mid-run, the production guard, the
// owner-only rule and planted divergences that the drift check must catch.

import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { DestructiveMigrationError } from '../migrate-guard.js';
import {
  loadMigrations,
  migrateDatabase,
  type MigrationLogger,
  MIGRATIONS_DIR,
  rollbackLatestMigration,
} from '../migrate.js';
import { diffCatalog, expectedCatalog, introspectCatalog, latestSnapshot } from './catalog.js';
import { detectSchemaDrift } from './generate.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./testdata/${name}`, import.meta.url));
const PRODUCTION = { NODE_ENV: 'production' } as const;

let real: PostgresHandle;
let scratch: PostgresHandle;
const realLog: { fields: Record<string, unknown>; message: string }[] = [];
const recorder = (sink: typeof realLog): MigrationLogger => ({
  info: (fields, message) => sink.push({ fields, message }),
});

async function withOwner<T>(
  handle: PostgresHandle,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await handle.ownerPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function tableExists(handle: PostgresHandle, table: string): Promise<boolean> {
  const { rows } = await handle.ownerPool.query<{ ok: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS ok',
    [table],
  );
  return rows[0]?.ok === true;
}

async function appliedCount(handle: PostgresHandle): Promise<number> {
  const { rows } = await handle.ownerPool.query<{ count: string }>(
    'SELECT count(*) FROM drizzle.__drizzle_migrations',
  );
  return Number(rows[0]?.count);
}

beforeAll(async () => {
  [real, scratch] = await Promise.all([
    withPostgres({
      migrations: (owner) => migrateDatabase(owner, recorder(realLog)).then(() => undefined),
    }),
    withPostgres({ migrations: () => Promise.resolve() }),
  ]);
}, 240_000);

afterAll(async () => {
  // beforeAll may have failed before the handles existed; do not mask that error with a teardown TypeError.
  await Promise.all([
    (real as PostgresHandle | undefined)?.stop(),
    (scratch as PostgresHandle | undefined)?.stop(),
  ]);
});

describe('pnpm db:migrate on a fresh database', () => {
  it('applies every migration as the owner and logs version and duration per migration', async () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(realLog[0]).toEqual({
      message: 'db.migrate.start',
      fields: { event: 'db.migrate.start', total: versions.length, pending: versions.length },
    });
    const applied = realLog.filter((line) => line.message === 'db.migrate.applied');
    expect(applied.map((line) => line.fields.version)).toEqual(versions);
    for (const line of applied) expect(line.fields.durationMs).toBeTypeOf('number');
    expect(await appliedCount(real)).toBe(versions.length);
    const { rows } = await real.ownerPool.query<{ owner: string }>(
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'kill_events'",
    );
    expect(rows[0]?.owner).toBe('bw_owner');
  });

  it('is idempotent: a re-run skips every migration and records nothing new', async () => {
    const log: typeof realLog = [];
    const result = await withOwner(real, (client) => migrateDatabase(client, recorder(log)));
    expect(result.applied).toEqual([]);
    expect(log.filter((l) => l.message === 'db.migrate.skipped')).toHaveLength(
      loadMigrations().length,
    );
    expect(await appliedCount(real)).toBe(loadMigrations().length);
  });

  it('refuses to run as bw_app (insufficient privilege, by design)', async () => {
    const app = await real.appPool.connect();
    try {
      await expect(migrateDatabase(app)).rejects.toMatchObject({ code: '42501' });
    } finally {
      app.release();
    }
  });
});

describe('a partially applied migration (crash mid-run)', () => {
  it('rolls the whole run back: no table, no recorded version', async () => {
    await expect(
      withOwner(scratch, (client) =>
        migrateDatabase(client, undefined, { migrationsDir: fixture('broken') }),
      ),
    ).rejects.toBeInstanceOf(pg.DatabaseError);
    expect(await tableExists(scratch, 'broken_probe')).toBe(false);
    expect(await appliedCount(scratch)).toBe(0);
  });
});

describe('forward-only production guard', () => {
  const guard = { migrationsDir: fixture('guard') };

  it('blocks a destructive migration in production without the flag, applying nothing', async () => {
    await expect(
      withOwner(scratch, (client) =>
        migrateDatabase(client, undefined, { ...guard, env: PRODUCTION }),
      ),
    ).rejects.toBeInstanceOf(DestructiveMigrationError);
    expect(await tableExists(scratch, 'guard_probe')).toBe(false);
    expect(await appliedCount(scratch)).toBe(0);
  });

  it('applies it with ALLOW_DESTRUCTIVE_MIGRATION=1', async () => {
    const env = { ...PRODUCTION, ALLOW_DESTRUCTIVE_MIGRATION: '1' };
    const result = await withOwner(scratch, (client) =>
      migrateDatabase(client, undefined, { ...guard, env }),
    );
    expect(result.applied).toEqual(['0000_probe', '0001_drop_note']);
  });

  it('refuses a down migration in production; allows it in development', async () => {
    await expect(
      withOwner(scratch, (client) =>
        rollbackLatestMigration(client, undefined, { ...guard, env: PRODUCTION }),
      ),
    ).rejects.toMatchObject({ direction: 'down' });
    expect(await appliedCount(scratch)).toBe(2);
    const reverted = await withOwner(scratch, (client) =>
      rollbackLatestMigration(client, undefined, { ...guard, env: { NODE_ENV: 'development' } }),
    );
    expect(reverted).toBe('0001_drop_note');
    expect(await appliedCount(scratch)).toBe(1);
    const { rows } = await scratch.ownerPool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'guard_probe' AND column_name = 'note'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe('drift check detects planted divergences', () => {
  it('an uncommitted schema edit makes drizzle-kit generate a migration', () => {
    const drift = detectSchemaDrift(MIGRATIONS_DIR, fixture('drifted-schema.ts'));
    expect(drift.error).toBeUndefined();
    expect(drift.generated).toHaveLength(1);
    expect(drift.generated[0]?.sql).toContain('CREATE TABLE "drift_probe"');
  }, 120_000);

  it('fails closed when drizzle-kit cannot load the schema', () => {
    const drift = detectSchemaDrift(MIGRATIONS_DIR, fixture('no-such-schema.ts'));
    expect(drift.generated).toEqual([]);
    expect(drift.error).toMatch(/drizzle-kit generate/u);
  }, 120_000);

  it('a database that diverges from the snapshot produces a catalogue diff', async () => {
    const last = loadMigrations().at(-1)?.version ?? '';
    await withOwner(real, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('ALTER TABLE soc_contacts ADD COLUMN planted text');
        await client.query('DROP INDEX soc_contacts_tenant_asset_idx');
        const diff = diffCatalog(
          expectedCatalog(latestSnapshot(MIGRATIONS_DIR, last)),
          await introspectCatalog(client),
        );
        expect(diff).toEqual([
          '+ column public.soc_contacts.planted text',
          '- index public.soc_contacts.soc_contacts_tenant_asset_idx',
        ]);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
