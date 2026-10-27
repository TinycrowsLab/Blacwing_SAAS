// `pnpm db:check` (DB-002): the committed migrations, the schema in src/schema/** and a scratch
// database built from those migrations must all agree. The scratch database is Postgres 16 +
// pgvector pinned by digest (@blackwing/testing), so extension or version differences cannot flake
// the check. On failure the evidence is appended to $BW_DB_CHECK_REPORT (the CI artifact).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { loadMigrations, migrateDatabase, MIGRATIONS_DIR } from '../migrate.js';
import { diffCatalog, expectedCatalog, introspectCatalog, latestSnapshot } from './catalog.js';
import { detectSchemaDrift } from './generate.js';
import { checkMigrationsDir } from './journal.js';
import { appendDriftReport } from './report.js';

const REPORT = process.env.BW_DB_CHECK_REPORT;

let db: PostgresHandle;

beforeAll(async () => {
  db = await withPostgres({
    migrations: async (owner) => {
      await migrateDatabase(owner);
    },
  });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('db:check', () => {
  it('the migrations folder is consistent (journal, snapshots, SQL lint)', () => {
    const problems = checkMigrationsDir(MIGRATIONS_DIR);
    appendDriftReport(REPORT, problems.length > 0 ? [{ title: 'Journal', lines: problems }] : []);
    expect(problems).toEqual([]);
  });

  it('the schema needs no new migration (pnpm db:generate is committed)', () => {
    const drift = detectSchemaDrift(MIGRATIONS_DIR);
    appendDriftReport(REPORT, [
      ...drift.generated.map((file) => ({
        title: `Uncommitted migration ${file.file} (run pnpm db:generate and commit it)`,
        lines: [file.sql],
        lang: 'sql' as const,
      })),
      ...(drift.error === undefined ? [] : [{ title: 'drizzle-kit', lines: [drift.error] }]),
    ]);
    expect(drift).toEqual({ generated: [] });
  });

  it('a database built from the migrations matches the schema snapshot', async () => {
    const migrations = loadMigrations();
    const last = migrations.at(-1)?.version ?? '';
    const client = await db.ownerPool.connect();
    try {
      const diff = diffCatalog(
        expectedCatalog(latestSnapshot(MIGRATIONS_DIR, last)),
        await introspectCatalog(client),
      );
      appendDriftReport(
        REPORT,
        diff.length > 0
          ? [
              {
                title: 'Migrations vs snapshot (- snapshot only, + database only)',
                lines: diff,
                lang: 'diff',
              },
            ]
          : [],
      );
      expect(diff).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('re-running the migrations is a no-op', async () => {
    const client = await db.ownerPool.connect();
    try {
      const result = await migrateDatabase(client);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual(loadMigrations().map((m) => m.version));
    } finally {
      client.release();
    }
  });
});
