import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR } from '../migrate.js';
import { checkMigrationsDir, lintMigrationSql, ROOT_SNAPSHOT_ID } from './journal.js';

interface Entry {
  readonly tag: string;
  readonly when: number;
  readonly id: string;
  readonly prevId: string;
  readonly sql?: string;
}

const dirs: string[] = [];

/** Writes a drizzle-kit style migrations folder. */
function folder(entries: readonly Entry[], extraFiles: readonly string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-journal-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'meta'));
  writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((e, idx) => ({ idx, version: '7', when: e.when, tag: e.tag })),
    }),
  );
  for (const e of entries) {
    writeFileSync(path.join(dir, `${e.tag}.sql`), e.sql ?? 'CREATE TABLE "t" ();');
    writeFileSync(
      path.join(dir, 'meta', `${e.tag.split('_')[0] ?? ''}_snapshot.json`),
      JSON.stringify({ id: e.id, prevId: e.prevId }),
    );
  }
  for (const file of extraFiles) writeFileSync(path.join(dir, file), 'SELECT 1;');
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base: Entry = { tag: '0000_init', when: 1000, id: 'a', prevId: ROOT_SNAPSHOT_ID };

describe('checkMigrationsDir', () => {
  it('passes on the committed migrations', () => {
    expect(checkMigrationsDir(MIGRATIONS_DIR)).toEqual([]);
  });

  it('passes on a linear history with timestamp prefixes', () => {
    const dir = folder([
      base,
      { tag: '20261021093000_users', when: 2000, id: 'b', prevId: 'a' },
      { tag: '20261021094500_orgs', when: 3000, id: 'c', prevId: 'b' },
    ]);
    expect(checkMigrationsDir(dir)).toEqual([]);
  });

  it('detects two PRs whose migrations collided (same prefix, forked snapshots)', () => {
    // Both branches generated 0001 on top of 0000 and git merged both journal entries.
    const dir = folder([
      base,
      { tag: '0001_users', when: 2000, id: 'b', prevId: 'a' },
      { tag: '0001_orgs', when: 2500, id: 'c', prevId: 'a' },
    ]);
    const problems = checkMigrationsDir(dir);
    expect(problems.some((p) => p.includes('share the prefix 0001'))).toBe(true);
    expect(problems.some((p) => p.includes('same parent'))).toBe(true);
    expect(problems.every((p) => !p.includes('same parent') || p.includes('rebase'))).toBe(true);
  });

  it('detects a migration older than its predecessor (it would be skipped on applied databases)', () => {
    const dir = folder([
      base,
      { tag: '20261021094500_orgs', when: 3000, id: 'b', prevId: 'a' },
      { tag: '20261021093000_users', when: 2000, id: 'c', prevId: 'b' },
    ]);
    expect(checkMigrationsDir(dir)).toEqual([
      expect.stringContaining('20261021093000_users is not newer than 20261021094500_orgs'),
    ]);
  });

  it('detects a snapshot that does not follow its predecessor', () => {
    const dir = folder([base, { tag: '0001_x', when: 2000, id: 'b', prevId: 'zzz' }]);
    expect(checkMigrationsDir(dir)).toEqual([expect.stringContaining('prevId mismatch')]);
  });

  it('detects a hand-added SQL file missing from the journal', () => {
    const dir = folder([base], ['0001_manual.sql']);
    expect(checkMigrationsDir(dir)).toEqual([
      expect.stringContaining('0001_manual.sql is not in meta/_journal.json'),
    ]);
  });

  it('reports a missing journal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-journal-'));
    dirs.push(dir);
    expect(checkMigrationsDir(dir)).toEqual([expect.stringContaining('_journal.json is missing')]);
  });

  it('applies the SQL lint to every migration', () => {
    const dir = folder([{ ...base, sql: 'CREATE EXTENSION vector;' }]);
    expect(checkMigrationsDir(dir)).toEqual([
      '0000_init.sql: CREATE EXTENSION must use IF NOT EXISTS (re-runnable after a partial apply)',
    ]);
  });
});

describe('lintMigrationSql', () => {
  it('requires idempotent non-transactional DDL', () => {
    expect(lintMigrationSql('m', 'CREATE EXTENSION IF NOT EXISTS citext;')).toEqual([]);
    expect(lintMigrationSql('m', 'CREATE EXTENSION  IF  NOT EXISTS citext;')).toEqual([]);
    expect(lintMigrationSql('m', "ALTER TYPE status ADD VALUE IF NOT EXISTS 'x';")).toEqual([]);
    expect(lintMigrationSql('m', "ALTER TYPE status ADD VALUE 'x';")).toHaveLength(1);
  });

  it('rejects statements that cannot run in the migration transaction', () => {
    expect(lintMigrationSql('m', 'CREATE INDEX CONCURRENTLY i ON t (c);')).toHaveLength(1);
    expect(lintMigrationSql('m', 'VACUUM t;')).toHaveLength(1);
  });

  it('rejects credentials in migration SQL, ignoring comments', () => {
    expect(lintMigrationSql('m', "ALTER ROLE r PASSWORD 'hunter2';")).toEqual([
      'm.sql: migrations must not contain credentials (roles get passwords from the secret store)',
    ]);
    expect(lintMigrationSql('m', "-- ALTER ROLE r PASSWORD 'x'\nSELECT 1;")).toEqual([]);
  });
});
