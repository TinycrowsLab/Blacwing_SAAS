// Persona overrides (REGISTRY-010): tenant isolation, the CHECK constraints, the runtime role's privileges and
// the audit write in the same transaction, against the real migrations on Postgres 16 (Testcontainers).
// Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { createPgPersonaOverrideStore } from './persona-overrides.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23514 check_violation, 42501 insufficient privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

const columns = {
  effort: 'low',
  maxTurns: 10,
  maxBudgetUsd: 2.5,
  lowerStandardTier: true,
} as const;

function store() {
  return createPgPersonaOverrideStore(createDatabase(db.appPool));
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('persona override store', () => {
  it('stores an override and reads it back for the same tenant', async () => {
    const saved = await store().replace(tenantA, 'osint', columns, () => Promise.resolve());
    expect(saved).toMatchObject({ tenantId: tenantA, persona: 'osint', ...columns });
    expect(await store().find(tenantA, 'osint')).toMatchObject({ maxTurns: 10, effort: 'low' });
  });

  it('keeps the audit write and the change in one transaction: a failing audit write stores nothing', async () => {
    const failing = store();
    await expect(
      failing.replace(tenantA, 'planner', columns, () =>
        Promise.reject(new Error('audit unavailable')),
      ),
    ).rejects.toThrow('audit unavailable');
    expect(await failing.find(tenantA, 'planner')).toBeNull();
  });

  it('a second write replaces the row and refreshes updated_at (one row per tenant and persona)', async () => {
    const first = await store().replace(tenantA, 'passive-recon', columns, () => Promise.resolve());
    const second = await store().replace(
      tenantA,
      'passive-recon',
      { ...columns, maxTurns: 3, effort: null },
      () => Promise.resolve(),
    );
    expect(second.maxTurns).toBe(3);
    expect(second.effort).toBeNull();
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    const count = await db.withTenant(tenantA, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM persona_overrides WHERE persona = 'passive-recon'"),
    );
    expect(count.rows[0]).toEqual({ n: 1 });
  });
});

describe('tenant isolation', () => {
  it("tenant B cannot read tenant A's override", async () => {
    await store().replace(tenantA, 'web-api-specialist', columns, () => Promise.resolve());
    expect(await store().find(tenantB, 'web-api-specialist')).toBeNull();
  });

  it("tenant B's write to the same persona leaves tenant A's override untouched", async () => {
    await store().replace(tenantA, 'infrastructure-specialist', columns, () => Promise.resolve());
    await store().replace(tenantB, 'infrastructure-specialist', { ...columns, maxTurns: 99 }, () =>
      Promise.resolve(),
    );
    expect(await store().find(tenantA, 'infrastructure-specialist')).toMatchObject({
      maxTurns: 10,
    });
    expect(await store().find(tenantB, 'infrastructure-specialist')).toMatchObject({
      maxTurns: 99,
    });
  });

  it('a row cannot be inserted under another tenant context', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO persona_overrides (tenant_id, persona, max_turns) VALUES ($1, 'osint', 1)`,
          [tenantA],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('an update aimed at another tenant row changes nothing', async () => {
    await store().replace(tenantA, 'reflector', columns, () => Promise.resolve());
    const updated = await db.withTenant(tenantB, (tx) =>
      tx.query("UPDATE persona_overrides SET max_turns = 1 WHERE persona = 'reflector'"),
    );
    expect(updated.rowCount).toBe(0);
    expect(await store().find(tenantA, 'reflector')).toMatchObject({ maxTurns: 10 });
  });
});

describe('database constraints (second gate behind the application whitelist)', () => {
  const insertAs = (
    tenantId: string,
    values: { persona?: string; effort?: string; maxTurns?: number; maxBudgetUsd?: number },
  ) =>
    db.withTenant(tenantId, (tx) =>
      tx.query(
        'INSERT INTO persona_overrides (tenant_id, persona, effort, max_turns, max_budget_usd) VALUES ($1, $2, $3, $4, $5)',
        [
          tenantId,
          values.persona ?? 'osint',
          values.effort ?? null,
          values.maxTurns ?? null,
          values.maxBudgetUsd ?? null,
        ],
      ),
    );

  it('refuses a persona name outside lowercase kebab-case', async () => {
    expect(await pgCode(insertAs(tenantA, { persona: 'Osint' }))).toBe('23514');
  });

  it('refuses an effort level outside the exported list', async () => {
    expect(await pgCode(insertAs(tenantA, { effort: 'extreme' }))).toBe('23514');
  });

  it('refuses maxTurns outside 1..10000', async () => {
    expect(await pgCode(insertAs(tenantA, { maxTurns: 0 }))).toBe('23514');
    expect(await pgCode(insertAs(tenantA, { maxTurns: 10_001 }))).toBe('23514');
  });

  it('refuses a non-positive or oversized maxBudgetUsd', async () => {
    expect(await pgCode(insertAs(tenantA, { maxBudgetUsd: 0 }))).toBe('23514');
    expect(await pgCode(insertAs(tenantA, { maxBudgetUsd: 10_001 }))).toBe('23514');
  });
});

describe('runtime role limits', () => {
  it('bw_app cannot delete an override or truncate the table', async () => {
    await store().replace(tenantA, 'session-setup', columns, () => Promise.resolve());
    const deleted = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query("DELETE FROM persona_overrides WHERE persona = 'session-setup'"),
      ),
    );
    expect(deleted).toBe('42501');
    const truncated = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query('TRUNCATE persona_overrides')),
    );
    expect(truncated).toBe('42501');
  });
});
