// Coverage repository (COVERAGE-001): create, record, immutability once finalised, tenant isolation and the database
// backstops, against the real migrations on Postgres (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { CoverageRepository } from './coverage.repository.js';
import { createDatabase, migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function makeRepo(tenant: string = tenantA) {
  return new CoverageRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
}

/** A run with one test case of the tenant (run -> plan -> case, bypassing the repositories). */
async function insertRunWithCase(tenant: string): Promise<{ runId: string; caseId: string }> {
  const runId = newId();
  const planId = newId();
  const caseId = newId();
  await db.withTenant(tenant, async (tx) => {
    await tx.query('INSERT INTO runs (id, tenant_id) VALUES ($1, $2)', [runId, tenant]);
    await tx.query(
      'INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)',
      [planId, tenant, runId],
    );
    await tx.query(
      `INSERT INTO test_cases (id, tenant_id, test_plan_id, class, title, targets, budget)
       VALUES ($1, $2, $3, 'passive', 'Probe the login form', '["https://app.example.test/login"]', '{"maxRequests":10}')`,
      [caseId, tenant, planId],
    );
  });
  return { runId, caseId };
}

/** A valid executed entry for a case; overrides change exactly the fields a test negates. */
function entry(testCaseId: string, over: Record<string, unknown> = {}) {
  return {
    testCaseId,
    title: 'Probe the login form',
    class: 'passive',
    owaspRefs: ['A07'],
    wstgRefs: ['WSTG-ATHN-01'],
    cweCandidates: ['CWE-307'],
    targets: ['https://app.example.test/login'],
    roles: ['anonymous'],
    outcome: 'executed',
    reason: null,
    subtaskId: null,
    budgetUsed: { requests: 4 },
    ...over,
  };
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('CoverageRepository.createManifest', () => {
  it('creates an open manifest with a cov_ public id for the tenant run', async () => {
    const { runId } = await insertRunWithCase(tenantA);
    const manifest = await makeRepo().createManifest({ runId });
    expect(manifest.publicId).toMatch(/^cov_[0-9a-z]+$/);
    expect(manifest).toMatchObject({ tenantId: tenantA, runId, status: 'open', finalisedAt: null });
  });

  it('refuses an unknown run, and another tenant’s run (RLS hides it)', async () => {
    const { runId } = await insertRunWithCase(tenantA);
    await expect(makeRepo().createManifest({ runId: newId() })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(makeRepo(tenantB).createManifest({ runId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a second manifest for the same run (one manifest per run)', async () => {
    const { runId } = await insertRunWithCase(tenantA);
    await makeRepo().createManifest({ runId });
    await expect(makeRepo().createManifest({ runId })).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects a malformed run id and an unexpected field before any write', async () => {
    await expect(makeRepo().createManifest({ runId: 'run_1' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      makeRepo().createManifest({ runId: newId(), tenantId: tenantB }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails closed with no tenant context', async () => {
    const { runId } = await insertRunWithCase(tenantA);
    const repo = new CoverageRepository({
      db: createDatabase(db.appPool),
      tenant: () => undefined,
    });
    await expect(repo.createManifest({ runId })).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});

describe('CoverageRepository.findByRun', () => {
  it('returns the manifest of a run with its rows, and undefined for a run without one', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const repo = makeRepo();
    expect(await repo.findByRun(runId)).toBeUndefined();
    const manifest = await repo.createManifest({ runId });
    await repo.upsertEntry(manifest.id, entry(caseId));
    const found = await repo.findByRun(runId);
    expect(found?.manifest.id).toBe(manifest.id);
    expect(found?.entries.map((row) => row.testCaseId)).toEqual([caseId]);
  });

  it('hides another tenant’s manifest', async () => {
    const { runId } = await insertRunWithCase(tenantA);
    await makeRepo().createManifest({ runId });
    expect(await makeRepo(tenantB).findByRun(runId)).toBeUndefined();
  });
});

describe('CoverageRepository.upsertEntry', () => {
  it('records a row once and updates it on a repeat for the same case while open', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const repo = makeRepo();
    const manifest = await repo.createManifest({ runId });

    await repo.upsertEntry(
      manifest.id,
      entry(caseId, { outcome: 'skipped', reason: 'out of scope' }),
    );
    await repo.upsertEntry(manifest.id, entry(caseId, { outcome: 'executed', reason: null }));

    const rows = await repo.listEntries(manifest.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'executed', reason: null, class: 'passive' });
  });

  it('refuses an unknown outcome and a missing reason before any write', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const repo = makeRepo();
    const manifest = await repo.createManifest({ runId });
    await expect(
      repo.upsertEntry(manifest.id, entry(caseId, { outcome: 'pending' })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repo.upsertEntry(manifest.id, entry(caseId, { outcome: 'blocked', reason: null })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.listEntries(manifest.id)).toEqual([]);
  });

  it('stores title and reason in Unicode NFC', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const repo = makeRepo();
    const manifest = await repo.createManifest({ runId });
    const row = await repo.upsertEntry(
      manifest.id,
      entry(caseId, { title: 'Café login', outcome: 'failed', reason: 'Café 500' }),
    );
    expect(row.title).toBe('Café login');
    expect(row.reason).toBe('Café 500');
  });

  it('refuses a test case of another tenant (composite foreign key)', async () => {
    const { runId } = await insertRunWithCase(tenantA);
    const foreign = await insertRunWithCase(tenantB);
    const repo = makeRepo();
    const manifest = await repo.createManifest({ runId });
    await expect(repo.upsertEntry(manifest.id, entry(foreign.caseId))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses a manifest of another tenant as not found (RLS hides it)', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const manifest = await makeRepo().createManifest({ runId });
    await expect(makeRepo(tenantB).upsertEntry(manifest.id, entry(caseId))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses every write to a finalised manifest and leaves its rows as they were', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const repo = makeRepo();
    const manifest = await repo.createManifest({ runId });
    await repo.upsertEntry(manifest.id, entry(caseId, { outcome: 'skipped', reason: 'before' }));
    // Finalisation itself is COVERAGE-004; here the row is finalised directly as the runtime role.
    await db.withTenant(tenantA, (tx) =>
      tx.query(
        `UPDATE coverage_manifests SET status = 'finalised', finalised_at = now(), sha256 = $2, pins = '{}', summary = '{}' WHERE id = $1`,
        [manifest.id, 'a'.repeat(64)],
      ),
    );

    await expect(
      repo.upsertEntry(manifest.id, entry(caseId, { outcome: 'executed', reason: null })),
    ).rejects.toBeInstanceOf(ConflictError);
    // A new case is refused too: the finalised check comes before any row is written.
    await expect(
      repo.upsertEntry(manifest.id, entry(newId(), { outcome: 'executed', reason: null })),
    ).rejects.toBeInstanceOf(ConflictError);
    const rows = await repo.listEntries(manifest.id);
    expect(rows.map((row) => row.outcome)).toEqual(['skipped']);
  });
});

describe('coverage_entries database backstops', () => {
  it('has forced row level security, so the owner role is confined to the tenant policy too', async () => {
    const { rows } = await db.ownerPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'coverage_entries'",
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('gives the runtime role no DELETE on a row', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const repo = makeRepo();
    const manifest = await repo.createManifest({ runId });
    await repo.upsertEntry(manifest.id, entry(caseId));
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM coverage_entries WHERE manifest_id = $1', [manifest.id]),
      ),
    );
    expect(code).toBe('42501');
  });

  it('refuses an outcome other than executed without a reason, even past the Zod layer', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const manifest = await makeRepo().createManifest({ runId });
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO coverage_entries (id, tenant_id, manifest_id, test_case_id, title, class, targets, outcome, reason)
           VALUES ($1, $2, $3, $4, 'x', 'passive', '["https://a.example.test"]', 'skipped', NULL)`,
          [newId(), tenantA, manifest.id, caseId],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('caps the opaque budget_used jsonb in bytes', async () => {
    const { runId, caseId } = await insertRunWithCase(tenantA);
    const manifest = await makeRepo().createManifest({ runId });
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO coverage_entries (id, tenant_id, manifest_id, test_case_id, title, class, targets, outcome, budget_used)
           VALUES ($1, $2, $3, $4, 'x', 'passive', '["https://a.example.test"]', 'executed', $5)`,
          [newId(), tenantA, manifest.id, caseId, JSON.stringify({ blob: 'x'.repeat(20_000) })],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('refuses a manifest whose status and finalisation time disagree', async () => {
    const { runId } = await insertRunWithCase(tenantA);
    const manifest = await makeRepo().createManifest({ runId });
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE coverage_manifests SET finalised_at = now() WHERE id = $1`, [manifest.id]),
      ),
    );
    expect(code).toBe('23514');
  });
});
