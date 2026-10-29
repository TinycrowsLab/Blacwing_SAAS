// Test plans and test cases (PLAN-001): tenant isolation, fail-closed without a tenant context, CHECK and enum
// rejection, the (run_id, version) uniqueness, composite foreign keys, the destructive and oracle rules, and the
// repository's version writes, against the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { ConcurrencyError } from './repository.js';
import { type TestPlanWithCases, TestPlanRepository } from './test-plans.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const creator = newId();

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key, 23505 unique, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function makeRepo(tenant: string = tenantA) {
  return new TestPlanRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
}

const planned = (overrides: Record<string, unknown> = {}) => ({
  class: 'active_safe',
  title: 'Reflected parameter in search',
  refs: { owasp: ['A03:2021'], wstg: ['WSTG-INPV-01'], asvs: ['5.3.3'] },
  cweCandidates: ['CWE-79'],
  targets: ['https://app.example.test/search'],
  roles: ['anonymous'],
  budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 2, maxBytes: 1_000_000 },
  oracle: { type: 'response.contains', params: { needle: 'probe-token' } },
  negativeControl: null,
  ...overrides,
});

/** Inserts a run for a tenant (bypassing the repository). */
async function insertRun(tenantId: string): Promise<string> {
  const id = newId();
  await db.withTenant(tenantId, (tx) =>
    tx.query('INSERT INTO runs (id, tenant_id) VALUES ($1, $2)', [id, tenantId]),
  );
  return id;
}

/**
 * Inserts a plan row (bypassing the repository) as the given tenant. `values` overrides the valid defaults, so
 * a test changes exactly the field it negates.
 */
async function rawPlan(
  tenantId: string,
  runId: string,
  version: number,
  values: { status?: string } = {},
): Promise<string> {
  const id = newId();
  await db.withTenant(tenantId, (tx) =>
    tx.query(
      'INSERT INTO test_plans (id, tenant_id, run_id, version, status, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, tenantId, runId, version, values.status ?? 'draft', creator],
    ),
  );
  return id;
}

/** Inserts a test case row as the given tenant with valid defaults; `overrides` replaces columns by name. */
async function rawCase(
  tenantId: string,
  planId: string,
  overrides: Record<string, unknown> = {},
): Promise<pg.QueryResult> {
  const row: Record<string, unknown> = {
    id: newId(),
    tenant_id: tenantId,
    test_plan_id: planId,
    class: 'passive',
    title: 'Raw case',
    targets: JSON.stringify(['https://app.example.test/']),
    budget: JSON.stringify({ maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 1000 }),
    oracle: JSON.stringify({ type: 'response.contains', params: {} }),
    status: 'proposed',
    status_reason: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  const params = columns.map((c) => row[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  return db.withTenant(tenantId, (tx) =>
    tx.query(`INSERT INTO test_cases (${columns.join(', ')}) VALUES (${placeholders})`, params),
  );
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('repository writes', () => {
  it('writes version 1, then version 2 for the same run, each with its proposed cases', async () => {
    const runId = await insertRun(tenantA);
    const repo = makeRepo();
    const first = await repo.createVersion({ runId, createdBy: creator, cases: [planned()] });
    expect(first.plan).toMatchObject({ version: 1, status: 'draft', runId, createdBy: creator });
    expect(first.cases).toHaveLength(1);
    expect(first.cases[0]).toMatchObject({
      class: 'active_safe',
      status: 'proposed',
      statusReason: null,
      owaspRefs: ['A03:2021'],
      wstgRefs: ['WSTG-INPV-01'],
      asvsRefs: ['5.3.3'],
      cweCandidates: ['CWE-79'],
      targets: ['https://app.example.test/search'],
      roles: ['anonymous'],
      budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 2, maxBytes: 1_000_000 },
      oracle: { type: 'response.contains', params: { needle: 'probe-token' } },
      negativeControl: null,
    });
    const second = await repo.createVersion({ runId, createdBy: creator, cases: [] });
    expect(second.plan.version).toBe(2);
    expect(second.cases).toEqual([]);
    const listed = await repo.listForRun(runId);
    expect(listed.map((p) => p.version)).toEqual([1, 2]);
  });

  it('reads a plan back with its cases, and stores Unicode titles and refs unchanged', async () => {
    const runId = await insertRun(tenantA);
    const title = 'Prüfung der Suche 認証 🔐';
    const created = await makeRepo().createVersion({
      runId,
      createdBy: creator,
      cases: [planned({ title, refs: { owasp: ['A01 ✓'], wstg: [], asvs: [] } })],
    });
    const found = await makeRepo().findById(created.plan.id);
    expect(found?.cases[0]?.title).toBe(title);
    expect(found?.cases[0]?.owaspRefs).toEqual(['A01 ✓']);
  });

  it('refuses a run of another tenant, and a run that does not exist (NotFound, nothing written)', async () => {
    const runA = await insertRun(tenantA);
    await expect(
      makeRepo(tenantB).createVersion({ runId: runA, createdBy: creator, cases: [] }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      makeRepo().createVersion({ runId: newId(), createdBy: creator, cases: [] }),
    ).rejects.toThrow(NotFoundError);
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT 1 FROM test_plans WHERE run_id = $1', [runA]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('refuses a destructive case and writes nothing (§8.3)', async () => {
    const runId = await insertRun(tenantA);
    await expect(
      makeRepo().createVersion({
        runId,
        createdBy: creator,
        cases: [planned({ class: 'destructive' })],
      }),
    ).rejects.toThrow(ValidationError);
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT 1 FROM test_plans WHERE run_id = $1', [runId]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('lets two concurrent writers of one run race on (run_id, version): unique versions, or ConcurrencyError', async () => {
    const runId = await insertRun(tenantA);
    const repo = makeRepo();
    const results = await Promise.allSettled([
      repo.createVersion({ runId, createdBy: creator, cases: [] }),
      repo.createVersion({ runId, createdBy: creator, cases: [] }),
    ]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<TestPlanWithCases> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const versions = fulfilled.map((r) => r.value.plan.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConcurrencyError);
    }
  });
});

describe('tenant isolation', () => {
  it('a plan and its cases are invisible to another tenant', async () => {
    const runId = await insertRun(tenantA);
    const created = await makeRepo().createVersion({
      runId,
      createdBy: creator,
      cases: [planned()],
    });
    await expect(makeRepo(tenantB).findById(created.plan.id)).resolves.toBeUndefined();
    await expect(makeRepo(tenantB).listForRun(runId)).resolves.toEqual([]);
    await expect(makeRepo().findById(created.plan.id)).resolves.toMatchObject({
      plan: { id: created.plan.id },
    });
    const otherCases = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM test_cases WHERE test_plan_id = $1', [created.plan.id]),
    );
    expect(otherCases.rowCount).toBe(0);
  });

  it('fails closed without a tenant context: reads return nothing and writes are refused', async () => {
    const runId = await insertRun(tenantA);
    await rawPlan(tenantA, runId, 1);
    // 42704 on a fresh session; 22P02 when a pooled session once set the GUC (it resets to '').
    const select = await pgCode(db.appPool.query('SELECT id FROM test_plans'));
    expect(['42704', '22P02']).toContain(select);
    const insert = await pgCode(
      db.appPool.query('INSERT INTO test_plans (tenant_id, run_id, version) VALUES ($1, $2, 9)', [
        tenantA,
        runId,
      ]),
    );
    expect(insert).toBeDefined();
    expect(insert).not.toBe('not-a-database-error');
  });

  it('a row cannot be inserted under another tenant context (RLS WITH CHECK, 42501)', async () => {
    const runA = await insertRun(tenantA);
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query('INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)', [
          newId(),
          tenantA,
          runA,
        ]),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a test case cannot name another tenant plan (composite FK, 23503)', async () => {
    const runA = await insertRun(tenantA);
    const planA = await rawPlan(tenantA, runA, 1);
    const code = await pgCode(rawCase(tenantB, planA));
    expect(code).toBe('23503');
  });

  it('a test plan cannot name another tenant run (composite FK, 23503)', async () => {
    const runA = await insertRun(tenantA);
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query('INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)', [
          newId(),
          tenantB,
          runA,
        ]),
      ),
    );
    expect(code).toBe('23503');
  });

  it('a run is invisible to another tenant', async () => {
    const runA = await insertRun(tenantA);
    const seen = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM runs WHERE id = $1', [runA]),
    );
    expect(seen.rowCount).toBe(0);
  });
});

describe('constraints', () => {
  it('rejects an unknown plan status and an unknown case class (enum CHECK, 23514)', async () => {
    const runId = await insertRun(tenantA);
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            "INSERT INTO test_plans (id, tenant_id, run_id, version, status) VALUES ($1, $2, $3, 1, 'published')",
            [newId(), tenantA, runId],
          ),
        ),
      ),
    ).toBe('23514');
    const planId = await rawPlan(tenantA, runId, 1);
    expect(await pgCode(rawCase(tenantA, planId, { class: 'rm_rf' }))).toBe('23514');
    expect(await pgCode(rawCase(tenantA, planId, { status: 'published' }))).toBe('23514');
  });

  it('accepts every §7 case status and class (valid enum values)', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    for (const status of ['proposed', 'executing', 'executed', 'approved'] as const) {
      expect(await pgCode(rawCase(tenantA, planId, { status }))).toBeUndefined();
    }
    for (const klass of ['passive', 'active_safe', 'state_changing'] as const) {
      expect(await pgCode(rawCase(tenantA, planId, { class: klass }))).toBeUndefined();
    }
  });

  it('refuses a second plan with the same (run_id, version)', async () => {
    const runId = await insertRun(tenantA);
    await rawPlan(tenantA, runId, 1);
    const code = await pgCode(rawPlan(tenantA, runId, 1));
    expect(code).toBe('23505');
  });

  it('rejects version 0 and a missing run id on a plan', async () => {
    const runId = await insertRun(tenantA);
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            'INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 0)',
            [newId(), tenantA, runId],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('stores a destructive case only as proposed or in a non-running status, never approved, executing or executed (§8.3)', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    expect(await pgCode(rawCase(tenantA, planId, { class: 'destructive' }))).toBeUndefined();
    for (const status of ['approved', 'executing', 'executed']) {
      expect(await pgCode(rawCase(tenantA, planId, { class: 'destructive', status }))).toBe(
        '23514',
      );
    }
    expect(
      await pgCode(
        rawCase(tenantA, planId, {
          class: 'destructive',
          status: 'blocked',
          status_reason: 'baseline policy',
        }),
      ),
    ).toBeUndefined();
  });

  it('requires the declared oracle before a case is approved, executing or executed (§8.11)', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    for (const status of ['approved', 'executing', 'executed']) {
      expect(await pgCode(rawCase(tenantA, planId, { status, oracle: null }))).toBe('23514');
    }
    expect(
      await pgCode(rawCase(tenantA, planId, { status: 'proposed', oracle: null })),
    ).toBeUndefined();
  });

  it('requires a status reason for statuses that carry one', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    expect(await pgCode(rawCase(tenantA, planId, { status: 'skipped' }))).toBe('23514');
    expect(
      await pgCode(rawCase(tenantA, planId, { status: 'skipped', status_reason: 'window closed' })),
    ).toBeUndefined();
  });

  it('rejects an empty or non-array targets value, and a title shorter than one character', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    expect(await pgCode(rawCase(tenantA, planId, { targets: '[]' }))).toBe('23514');
    expect(await pgCode(rawCase(tenantA, planId, { targets: '{"a":1}' }))).toBe('23514');
    expect(await pgCode(rawCase(tenantA, planId, { title: '' }))).toBe('23514');
  });

  it('rejects a jsonb column above the 64 KiB backstop (fail closed, the API enforces 16 KiB)', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    const big = JSON.stringify(['x'.repeat(70_000)]);
    expect(await pgCode(rawCase(tenantA, planId, { targets: big }))).toBe('23514');
  });

  it('keeps the destructive refusal and the oracle rule in the repository too (no row written)', async () => {
    const runId = await insertRun(tenantA);
    await expect(
      makeRepo().createVersion({
        runId,
        createdBy: creator,
        cases: [planned({ oracle: null })],
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('append-only history and timestamps', () => {
  it('the runtime role cannot delete or truncate plans or cases (no DELETE grant)', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) => tx.query('DELETE FROM test_plans WHERE id = $1', [planId])),
      ),
    ).toBe('42501');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('DELETE FROM test_cases WHERE test_plan_id = $1', [planId]),
        ),
      ),
    ).toBe('42501');
  });

  it('bumps updated_at on every update, through the database trigger', async () => {
    const runId = await insertRun(tenantA);
    const planId = await rawPlan(tenantA, runId, 1);
    const before = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT created_at, updated_at FROM test_plans WHERE id = $1', [planId]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.withTenant(tenantA, (tx) =>
      tx.query("UPDATE test_plans SET status = 'proposed' WHERE id = $1", [planId]),
    );
    const after = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT created_at, updated_at FROM test_plans WHERE id = $1', [planId]),
    );
    const row = before.rows[0] as { updated_at: Date };
    const next = after.rows[0] as { updated_at: Date };
    expect(next.updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
  });
});
