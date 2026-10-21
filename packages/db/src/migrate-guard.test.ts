import { describe, expect, it } from 'vitest';

import {
  assertMigrationAllowed,
  DestructiveMigrationError,
  findDestructiveStatements,
} from './migrate-guard.js';

const prod = { NODE_ENV: 'production' } as const;

describe('findDestructiveStatements', () => {
  it('finds data-losing and RLS-weakening statements in source order', () => {
    const sql = `
      ALTER TABLE "t" DROP COLUMN "c";
      DROP TABLE IF EXISTS "old";
      TRUNCATE "x";
      delete from "y" where true;
      ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "t" DISABLE ROW LEVEL SECURITY;
      drop   materialized   view "mv";`;
    expect(findDestructiveStatements(sql).map((s) => [s.kind, s.match])).toEqual([
      ['drop', 'DROP COLUMN'],
      ['drop', 'DROP TABLE'],
      ['truncate', 'TRUNCATE'],
      ['delete', 'DELETE FROM'],
      ['rls_weakening', 'NO FORCE ROW LEVEL SECURITY'],
      ['rls_weakening', 'DISABLE ROW LEVEL SECURITY'],
      ['drop', 'DROP MATERIALIZED VIEW'],
    ]);
  });

  it('ignores additive DDL and commented-out SQL', () => {
    const sql = `
      -- DROP TABLE "kept";
      /* TRUNCATE "kept"; */
      CREATE TABLE "t" ("id" uuid PRIMARY KEY);
      CREATE INDEX "t_idx" ON "t" ("id");
      DROP INDEX "t_old_idx";
      ALTER TABLE "t" FORCE ROW LEVEL SECURITY;`;
    expect(findDestructiveStatements(sql)).toEqual([]);
  });
});

describe('assertMigrationAllowed', () => {
  const destructive = { version: '0007_drop', direction: 'up', sql: 'DROP TABLE "t";' } as const;

  it('blocks a destructive migration in production without the flag', () => {
    expect(() => {
      assertMigrationAllowed(destructive, prod);
    }).toThrow(DestructiveMigrationError);
    expect(() => {
      assertMigrationAllowed(destructive, { ...prod, ALLOW_DESTRUCTIVE_MIGRATION: '0' });
    }).toThrow(/forward-only/u);
  });

  it('allows it with ALLOW_DESTRUCTIVE_MIGRATION=1, or outside production', () => {
    expect(() => {
      assertMigrationAllowed(destructive, { ...prod, ALLOW_DESTRUCTIVE_MIGRATION: '1' });
    }).not.toThrow();
    expect(() => {
      assertMigrationAllowed(destructive, { NODE_ENV: 'development' });
    }).not.toThrow();
    expect(() => {
      assertMigrationAllowed(destructive, {});
    }).not.toThrow();
  });

  it('only the exact value 1 counts as the flag', () => {
    expect(() => {
      assertMigrationAllowed(destructive, { ...prod, ALLOW_DESTRUCTIVE_MIGRATION: 'true' });
    }).toThrow(DestructiveMigrationError);
  });

  it('allows additive migrations in production', () => {
    expect(() => {
      assertMigrationAllowed({ version: '0008', direction: 'up', sql: 'CREATE TABLE t ();' }, prod);
    }).not.toThrow();
  });

  it('refuses any down migration in production, naming the version', () => {
    const down = { version: '0007_add', direction: 'down', sql: 'SELECT 1;' } as const;
    let error: unknown;
    try {
      assertMigrationAllowed(down, prod);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DestructiveMigrationError);
    expect(error).toMatchObject({ version: '0007_add', direction: 'down' });
    expect(() => {
      assertMigrationAllowed(down, { ...prod, ALLOW_DESTRUCTIVE_MIGRATION: '1' });
    }).not.toThrow();
  });
});
