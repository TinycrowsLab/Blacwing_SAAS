// Plan validation reads (PLAN-006, #396): the validation snapshot of a plan is one consistent, tenant-scoped read of the
// plan, its live cases, the run's standing authorisation, the run budget and the asset role matrices. Against the real
// migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`. Another tenant's plan reads as absent, a read with
// no tenant fails closed, and the audit event is written under the event's tenant.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import {
  PlanValidationRepository,
  type PlanValidatedAuditEvent,
} from './plan-validation.repository.js';
import { TestPlanRepository } from './test-plans.repository.js';

import type { PlannedTestCase } from '@blackwing/contracts';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const requester = newId();

const planned: PlannedTestCase = {
  class: 'active_safe',
  title: 'Reflected parameter in search',
  refs: { owasp: ['A03:2021'], wstg: ['WSTG-INPV-01'], asvs: ['5.3.3'] },
  cweCandidates: ['CWE-79'],
  targets: ['https://app.example.test/search'],
  roles: ['anonymous'],
  budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 2, maxBytes: 1_000_000 },
  oracle: { type: 'response.contains', params: { needle: 'probe' } },
  negativeControl: null,
};

/** Inserts a run and its assessment request under the same id (the request is the run's authorisation source). */
async function insertRunWithRequest(
  tenantId: string,
  saId: string | null,
  assetIds: readonly string[] = [],
): Promise<string> {
  const runId = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query('INSERT INTO runs (id, tenant_id) VALUES ($1, $2)', [runId, tenantId]);
    await tx.query(
      `INSERT INTO assessment_requests
         (id, tenant_id, public_id, mode, objective, asset_ids, max_intrusiveness, budgets, trigger, requested_by, status, sa_id)
       VALUES ($1, $2, $3, 'black', 'validation', $4, 'active_safe', $5, 'api', $6, $7, $8)`,
      [
        runId,
        tenantId,
        `areq_${runId.replaceAll('-', '')}`,
        [...assetIds],
        JSON.stringify({ costCapUsd: 10, maxRequests: 500, maxDurationMs: 60_000 }),
        requester,
        saId === null ? 'draft' : 'submitted',
        saId,
      ],
    );
  });
  return runId;
}

/** Inserts an asset with an active role matrix declaring `roles`, and returns its id. */
async function insertAssetWithMatrix(
  tenantId: string,
  roles: readonly string[] | null,
): Promise<string> {
  const assetId = newId();
  const owner = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query('INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)', [
      owner,
      `plan-${owner}`,
      `plan-${owner}@example.test`,
    ]);
    await tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id, verification_status, verification_method, verified_at)
       VALUES ($1, $2, $3, 'web_app', 'Shop', '[{"kind":"host","value":"app.example.test"}]', 'staging', $4, 'verified', 'dns_txt', now())`,
      [assetId, tenantId, `asset_${assetId.replaceAll('-', '')}`, owner],
    );
    if (roles !== null) {
      await tx.query(
        'INSERT INTO role_matrices (id, tenant_id, asset_id, version, matrix, active) VALUES ($1, $2, $3, 1, $4, true)',
        [newId(), tenantId, assetId, JSON.stringify({ roles, functions: [] })],
      );
    }
  });
  return assetId;
}

/** Inserts an active SA of `tenantId` over `assetIds` and returns its id. */
async function insertSa(tenantId: string, assetIds: readonly string[]): Promise<string> {
  const id = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id, status)
       VALUES ($1, $2, $3, $4::uuid[], '{"rules":[{"effect":"include","host":"*.example.test"}]}', 'active_safe', '{"maxRequests":100,"maxBytes":2000000}', '[]', now() - interval '1 day', now() + interval '30 days', $5, 'active')`,
      [id, tenantId, `sa_${id.replaceAll('-', '')}`, [...assetIds], requester],
    );
  });
  return id;
}

/** A plan of `tenantId` for `runId` with one case, created through the repository (the plan editor's write path). */
async function createPlan(tenantId: string, runId: string): Promise<string> {
  const repo = new TestPlanRepository({
    db: createDatabase(db.appPool),
    tenant: () => tenantId,
    audit: () => undefined,
  });
  const created = await repo.createVersion({ runId, createdBy: requester, cases: [planned] });
  return created.plan.id;
}

function validationRepo(audit: (event: PlanValidatedAuditEvent) => void = () => undefined) {
  return new PlanValidationRepository({
    db: createDatabase(db.appPool),
    audit: async (event, tx) => {
      // The hook runs inside the validation's transaction, under the event's tenant.
      const rows = await tx.execute(sql`SELECT current_setting('app.tenant_id', true) AS tenant`);
      expect(rows.rows[0]).toEqual({ tenant: event.tenantId });
      audit(event);
    },
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('PlanValidationRepository.snapshot (PLAN-006)', () => {
  it('reads the plan, its live cases, the SA, the run budget and the role matrix of one tenant', async () => {
    const asset = await insertAssetWithMatrix(tenantA, ['anonymous', 'customer']);
    const sa = await insertSa(tenantA, [asset]);
    const run = await insertRunWithRequest(tenantA, sa, [asset]);
    const planId = await createPlan(tenantA, run);

    const snapshot = await validationRepo().snapshot(tenantA, planId);
    expect(snapshot).toMatchObject({
      saId: sa,
      runBudgets: { maxRequests: 500 },
      knownRoles: ['anonymous', 'customer'],
      authorisation: {
        id: sa,
        status: 'active',
        maxIntrusiveness: 'active_safe',
        defaultBudgets: { maxRequests: 100, maxBytes: 2_000_000 },
        assetIds: [asset],
      },
    });
    expect(snapshot?.cases).toHaveLength(1);
    expect(snapshot?.plan.id).toBe(planId);
  });

  it('leaves out a removed case', async () => {
    const asset = await insertAssetWithMatrix(tenantA, ['anonymous']);
    const sa = await insertSa(tenantA, [asset]);
    const run = await insertRunWithRequest(tenantA, sa, [asset]);
    const repo = new TestPlanRepository({
      db: createDatabase(db.appPool),
      tenant: () => tenantA,
      audit: () => undefined,
    });
    const created = await repo.createVersion({
      runId: run,
      createdBy: requester,
      cases: [planned, planned],
    });
    const [first] = created.cases;
    if (first === undefined) throw new Error('expected a case');
    await db.withTenant(tenantA, (tx) =>
      tx.query(
        "UPDATE test_cases SET status = 'removed', status_reason = 'removed' WHERE id = $1",
        [first.id],
      ),
    );
    const snapshot = await validationRepo().snapshot(tenantA, created.plan.id);
    expect(snapshot?.cases).toHaveLength(1);
  });

  it('reads another tenant’s plan as absent (no existence leak)', async () => {
    const asset = await insertAssetWithMatrix(tenantA, ['anonymous']);
    const sa = await insertSa(tenantA, [asset]);
    const run = await insertRunWithRequest(tenantA, sa, [asset]);
    const planId = await createPlan(tenantA, run);
    expect(await validationRepo().snapshot(tenantB, planId)).toBeUndefined();
  });

  it('reports no SA when the request names none, and no known roles when an asset has no active matrix', async () => {
    const asset = await insertAssetWithMatrix(tenantB, null);
    const sa = await insertSa(tenantB, [asset]);
    const noSa = await insertRunWithRequest(tenantB, null);
    const noSaPlan = await createPlan(tenantB, noSa);
    const withoutSa = await validationRepo().snapshot(tenantB, noSaPlan);
    expect(withoutSa).toMatchObject({
      saId: null,
      authorisation: undefined,
      runBudgets: { maxRequests: 500 },
    });

    const run = await insertRunWithRequest(tenantB, sa, [asset]);
    const planId = await createPlan(tenantB, run);
    expect((await validationRepo().snapshot(tenantB, planId))?.knownRoles).toBeNull();
  });

  it('fails closed without a tenant context', async () => {
    await expect(validationRepo().snapshot('', newId())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });
});

describe('PlanValidationRepository.recordValidated (PLAN-006)', () => {
  it('writes the audit event inside a transaction under the event tenant', async () => {
    const seen: PlanValidatedAuditEvent[] = [];
    const repo = validationRepo((event) => seen.push(event));
    await repo.recordValidated({
      action: 'test_plan.validated',
      tenantId: tenantA,
      actorId: requester,
      planId: newId(),
      runId: newId(),
      version: 1,
      saId: null,
      ok: false,
      violationCount: 2,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ok: false, violationCount: 2 });
  });

  it('propagates a failed audit write, so no verdict is returned without its record', async () => {
    const repo = new PlanValidationRepository({
      db: createDatabase(db.appPool),
      audit: () => {
        throw new Error('ledger unavailable');
      },
    });
    await expect(
      repo.recordValidated({
        action: 'test_plan.validated',
        tenantId: tenantA,
        actorId: requester,
        planId: newId(),
        runId: newId(),
        version: 1,
        saId: null,
        ok: true,
        violationCount: 0,
      }),
    ).rejects.toThrow('ledger unavailable');
  });
});
