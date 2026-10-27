// Unit tests for the reset() statement sequence, against a fake owner pool (no Docker needed).
// The real behaviour (truncation, RLS, isolation between containers) is proven in pg-container.int.test.ts.

import { describe, expect, it } from 'vitest';

import { type TestSeed, resetTestDatabase } from './pg-container.js';

import type pg from 'pg';

interface FakeOptions {
  readonly tenantTables: readonly string[];
  /** Tables that have a BEFORE TRUNCATE trigger. */
  readonly guarded?: readonly string[];
  /** Makes every statement whose SQL matches this regex throw. */
  readonly failOn?: RegExp;
}

interface FakeOwner {
  readonly pool: pg.Pool;
  readonly statements: string[];
  readonly released: () => number;
}

/** A pool whose catalogue queries answer from `options` and whose client records every statement. */
function fakeOwner(options: FakeOptions): FakeOwner {
  const statements: string[] = [];
  let released = 0;
  const run = (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    // Catalogue lookups are not part of the reset transaction: answer them without recording.
    if (sql.includes('pg_attribute')) {
      return Promise.resolve({ rows: options.tenantTables.map((t) => ({ t })) });
    }
    if (sql.includes('tgtype')) {
      const asked = (params?.[1] as string[] | undefined) ?? [];
      const guarded = options.guarded ?? [];
      return Promise.resolve({
        rows: asked.filter((t) => guarded.includes(t)).map((t) => ({ t })),
      });
    }
    statements.push(sql);
    if (options.failOn?.test(sql)) return Promise.reject(new Error(`boom: ${sql}`));
    return Promise.resolve({ rows: [] });
  };
  const client = {
    query: run,
    release: () => {
      released += 1;
    },
  };
  const pool = {
    query: run,
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
  return { pool, statements, released: () => released };
}

describe('resetTestDatabase', () => {
  it('truncates every tenant table in one statement, inside a transaction', async () => {
    const owner = fakeOwner({ tenantTables: ['memberships', 'secrets'] });

    await resetTestDatabase(owner.pool);

    const truncate = owner.statements.filter((sql) => sql.startsWith('TRUNCATE'));
    expect(truncate).toEqual(['TRUNCATE "memberships", "secrets" CASCADE']);
    expect(owner.statements[0]).toBe('BEGIN');
    expect(owner.statements.at(-1)).toBe('COMMIT');
    expect(owner.released()).toBe(1);
  });

  it('runs the seed again after truncating, before COMMIT', async () => {
    const owner = fakeOwner({ tenantTables: ['memberships'] });
    const seeded: string[] = [];
    const seed: TestSeed = async (client) => {
      seeded.push('seed');
      await client.query('INSERT INTO "memberships" DEFAULT VALUES');
    };

    await resetTestDatabase(owner.pool, seed);

    expect(owner.statements).toEqual([
      'BEGIN',
      'TRUNCATE "memberships" CASCADE',
      'INSERT INTO "memberships" DEFAULT VALUES',
      'COMMIT',
    ]);
    expect(seeded).toEqual(['seed']);
  });

  it('keeps the truncate guard of append-only ledgers: disabled only around the truncate', async () => {
    const owner = fakeOwner({
      tenantTables: ['audit_events', 'memberships'],
      guarded: ['audit_events'],
    });

    await resetTestDatabase(owner.pool);

    const dml = owner.statements.filter(
      (sql) => sql.startsWith('ALTER') || sql.startsWith('TRUNCATE'),
    );
    expect(dml).toEqual([
      'ALTER TABLE "audit_events" DISABLE TRIGGER USER',
      'TRUNCATE "audit_events", "memberships" CASCADE',
      'ALTER TABLE "audit_events" ENABLE TRIGGER USER',
    ]);
    expect(owner.statements.at(-1)).toBe('COMMIT');
  });

  it('rolls back and rethrows when the truncate fails, so the guard is restored', async () => {
    const owner = fakeOwner({
      tenantTables: ['audit_events'],
      guarded: ['audit_events'],
      failOn: /^TRUNCATE/,
    });

    await expect(resetTestDatabase(owner.pool)).rejects.toThrow('boom: TRUNCATE');

    expect(owner.statements).toContain('ROLLBACK');
    expect(owner.statements).not.toContain('COMMIT');
    expect(owner.released()).toBe(1);
  });

  it('rolls back when the seed fails', async () => {
    const owner = fakeOwner({ tenantTables: ['memberships'] });
    const seed: TestSeed = () => Promise.reject(new Error('seed broke'));

    await expect(resetTestDatabase(owner.pool, seed)).rejects.toThrow('seed broke');

    expect(owner.statements).toContain('ROLLBACK');
    expect(owner.statements).not.toContain('COMMIT');
    expect(owner.released()).toBe(1);
  });

  it('skips the truncate when there are no tenant tables but still seeds', async () => {
    const owner = fakeOwner({ tenantTables: [] });
    let seeded = false;

    await resetTestDatabase(owner.pool, () => {
      seeded = true;
      return Promise.resolve();
    });

    expect(owner.statements.some((sql) => sql.startsWith('TRUNCATE'))).toBe(false);
    expect(seeded).toBe(true);
  });

  it('quotes table names so a hostile catalogue name cannot inject SQL', async () => {
    const owner = fakeOwner({ tenantTables: ['weird"name; DROP TABLE users'] });

    await resetTestDatabase(owner.pool);

    expect(owner.statements).toContain('TRUNCATE "weird""name; DROP TABLE users" CASCADE');
  });
});
