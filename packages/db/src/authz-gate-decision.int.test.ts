// Gate decisions (AUTHZ): tenant isolation, append-only grants, the one-approval unique index, CHECK constraints,
// and the repository write path (SoD, audit inside the transaction, fail-closed tenant context) against the real
// migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SodViolationError } from '@blackwing/domain/sod';
import { ConflictError, TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase } from './client.js';
import { AuthzGateDecisionRepository } from './index.js';
import { migrateDatabase } from './migrate.js';

import type { GateDecisionInput } from '@blackwing/contracts';
import type { GateDecisionAuditEvent } from '@blackwing/domain';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise, or `undefined` when it resolved. */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the decision to be refused');
}

function input(overrides: Partial<GateDecisionInput> = {}): GateDecisionInput {
  return {
    gate: 1,
    subjectType: 'test_plan',
    subjectId: newId(),
    decision: 'approved',
    requesterId: newId(),
    actorId: newId(),
    reason: null,
    decidedAt: null,
    timeoutAt: null,
    auto: false,
    ...overrides,
  };
}

function makeRepo(tenant: string | undefined, audited: GateDecisionAuditEvent[] = []) {
  const audit = (event: GateDecisionAuditEvent) => {
    audited.push(event);
    return Promise.resolve();
  };
  return new AuthzGateDecisionRepository({
    db: createDatabase(db.appPool),
    tenant: () => tenant,
    audit,
  });
}

/** Counts every decision `tenant` can see (RLS applies). */
async function totalRows(tenant: string): Promise<number> {
  return db.withTenant(tenant, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      'SELECT count(*) AS n FROM authz_gate_decisions',
    );
    return Number(rows[0]?.n);
  });
}

/** Reads the decisions of one subject as `tenant` (RLS applies). */
async function rowsFor(tenant: string, subjectId: string): Promise<number> {
  return db.withTenant(tenant, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      'SELECT count(*) AS n FROM authz_gate_decisions WHERE subject_id = $1',
      [subjectId],
    );
    return Number(rows[0]?.n);
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await db.ownerPool.query('TRUNCATE authz_gate_decisions');
});

describe('repository write path (SoD, audit, tenant)', () => {
  it('records an approval by a distinct approver and audits it inside the transaction', async () => {
    const audited: GateDecisionAuditEvent[] = [];
    const repo = makeRepo(tenantA, audited);
    const requester = newId();
    const actor = newId();
    const subjectId = newId();
    const row = await repo.record(input({ subjectId, requesterId: requester, actorId: actor }));
    expect(row).toMatchObject({ gate: 1, decision: 'approved', actorId: actor, auto: false });
    expect(audited).toEqual([
      expect.objectContaining({
        action: 'authz.gate.decision',
        decisionId: row.id,
        actorId: actor,
      }),
    ]);
    expect(await rowsFor(tenantA, subjectId)).toBe(1);
  });

  it.each([1, 2] as const)(
    'refuses a gate %i self-approval: SodViolationError, no row, no audit',
    async (gate) => {
      const audited: GateDecisionAuditEvent[] = [];
      const repo = makeRepo(tenantA, audited);
      const person = newId();
      const subjectId = newId();
      const error = await refusal(
        repo.record(input({ gate, subjectId, requesterId: person, actorId: person })),
      );
      expect(error).toBeInstanceOf(SodViolationError);
      expect(error).toMatchObject({ code: 'SOD_VIOLATION', reason: 'requester_equals_approver' });
      expect(audited).toEqual([]);
      expect(await rowsFor(tenantA, subjectId)).toBe(0);
    },
  );

  it('does not apply SoD to gate 3 (findings release)', async () => {
    const repo = makeRepo(tenantA);
    const person = newId();
    const subjectId = newId();
    const row = await repo.record(
      input({ gate: 3, subjectType: 'run', subjectId, requesterId: person, actorId: person }),
    );
    expect(row).toMatchObject({ gate: 3, actorId: person });
  });

  it('stores an automatic decision with no actor', async () => {
    const repo = makeRepo(tenantA);
    const subjectId = newId();
    const row = await repo.record(
      input({ decision: 'auto_approved', auto: true, actorId: null, requesterId: null, subjectId }),
    );
    expect(row).toMatchObject({ decision: 'auto_approved', actorId: null, auto: true });
    const { rows } = await db.withTenant(tenantA, (tx) =>
      tx.query<{ actor_id: string | null; auto: boolean }>(
        'SELECT actor_id, auto FROM authz_gate_decisions WHERE id = $1',
        [row.id],
      ),
    );
    expect(rows[0]).toEqual({ actor_id: null, auto: true });
  });

  it('fails closed without a tenant context and writes nothing', async () => {
    const repo = makeRepo(undefined);
    const error = await refusal(repo.record(input()));
    expect(error).toBeInstanceOf(TenantContextMissingError);
    expect(await totalRows(tenantA)).toBe(0);
  });
});

describe('one approval per gate and subject (race-safety backstop)', () => {
  it('refuses a second approved decision for the same gate and subject', async () => {
    const repo = makeRepo(tenantA);
    const subjectId = newId();
    await repo.record(input({ subjectId }));
    const error = await refusal(repo.record(input({ subjectId })));
    expect(error).toBeInstanceOf(ConflictError);
    expect(await rowsFor(tenantA, subjectId)).toBe(1);
  });

  it('lets only one of two concurrent approvals of one subject commit', async () => {
    const repo = makeRepo(tenantA);
    const subjectId = newId();
    const results = await Promise.allSettled([
      repo.record(input({ subjectId })),
      repo.record(input({ subjectId })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toBeInstanceOf(ConflictError);
    expect(await rowsFor(tenantA, subjectId)).toBe(1);
  });

  it('does not count rejections or deferrals against the approval', async () => {
    const repo = makeRepo(tenantA);
    const subjectId = newId();
    await repo.record(input({ subjectId, decision: 'rejected' }));
    await repo.record(input({ subjectId, decision: 'deferred' }));
    await repo.record(input({ subjectId, decision: 'rejected' }));
    await expect(repo.record(input({ subjectId }))).resolves.toMatchObject({
      decision: 'approved',
    });
  });
});

describe('tenant isolation and append-only grants', () => {
  it('hides tenant A decisions from tenant B', async () => {
    const subjectId = newId();
    await makeRepo(tenantA).record(input({ subjectId }));
    expect(await rowsFor(tenantB, subjectId)).toBe(0);
  });

  it('refuses a write that names another tenant (WITH CHECK)', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO authz_gate_decisions (id, tenant_id, gate, subject_type, subject_id, decision, auto)
           VALUES ($1, $2, 1, 'test_plan', $3, 'rejected', false)`,
          [newId(), tenantA, newId()],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('fails closed on a raw read without a tenant context', async () => {
    // Unset context raises 42704; a context emptied by a finished transaction raises 22P02 (not a uuid).
    // Both fail closed, and `toTenantIsolationError` maps both to TenantContextMissingError.
    const code = await pgCode(db.appPool.query('SELECT count(*) FROM authz_gate_decisions'));
    expect(['42704', '22P02']).toContain(code);
  });

  it('keeps decisions append-only for the runtime role (no UPDATE, DELETE or TRUNCATE)', async () => {
    const subjectId = newId();
    await makeRepo(tenantA).record(input({ subjectId }));
    const update = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('UPDATE authz_gate_decisions SET decision = $1 WHERE subject_id = $2', [
          'rejected',
          subjectId,
        ]),
      ),
    );
    const remove = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM authz_gate_decisions WHERE subject_id = $1', [subjectId]),
      ),
    );
    const truncate = await pgCode(db.appPool.query('TRUNCATE authz_gate_decisions'));
    expect([update, remove, truncate]).toEqual(['42501', '42501', '42501']);
  });
});

describe('column CHECK constraints', () => {
  it.each([
    ['gate 4', { gate: 4 }],
    ['decision maybe', { decision: 'maybe' }],
    ['subject type report', { subject_type: 'report' }],
  ])('rejects %s on a direct write', async (_label, override) => {
    const row = {
      gate: 1,
      subject_type: 'test_plan',
      decision: 'rejected',
      ...override,
    };
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO authz_gate_decisions (id, tenant_id, gate, subject_type, subject_id, decision, auto)
           VALUES ($1, $2, $3, $4, $5, $6, false)`,
          [newId(), tenantA, row.gate, row.subject_type, newId(), row.decision],
        ),
      ),
    );
    expect(code).toBe('23514');
  });
});

describe('database separation of duties (#398, §8.4)', () => {
  // Writes straight to the table through the tenant transaction, skipping the service check: the CHECK must refuse.
  const direct = (values: {
    gate: number;
    decision: string;
    requester: string | null;
    actor: string | null;
    auto?: boolean;
  }) =>
    pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO authz_gate_decisions
             (id, tenant_id, gate, subject_type, subject_id, decision, requester_id, actor_id, auto)
           VALUES ($1, $2, $3, 'test_plan', $4, $5, $6, $7, $8)`,
          [
            newId(),
            tenantA,
            values.gate,
            newId(),
            values.decision,
            values.requester,
            values.actor,
            values.auto ?? false,
          ],
        ),
      ),
    );

  it('refuses a Gate 1 approval where the actor is the requester, on a direct write', async () => {
    const person = newId();
    expect(await direct({ gate: 1, decision: 'approved', requester: person, actor: person })).toBe(
      '23514',
    );
  });

  it('refuses a Gate 2 approval where the actor is the requester, on a direct write', async () => {
    const person = newId();
    expect(await direct({ gate: 2, decision: 'approved', requester: person, actor: person })).toBe(
      '23514',
    );
  });

  it('refuses an approval with no known requester (fail closed) on a direct write', async () => {
    expect(await direct({ gate: 1, decision: 'approved', requester: null, actor: newId() })).toBe(
      '23514',
    );
  });

  it('accepts a Gate 1 approval by a distinct actor', async () => {
    expect(
      await direct({ gate: 1, decision: 'approved', requester: newId(), actor: newId() }),
    ).toBeUndefined();
  });

  it('does not apply the requester rule to Gate 3, to rejections or to automatic decisions', async () => {
    const person = newId();
    expect(
      await direct({ gate: 3, decision: 'approved', requester: person, actor: person }),
    ).toBeUndefined();
    expect(
      await direct({ gate: 1, decision: 'rejected', requester: person, actor: person }),
    ).toBeUndefined();
    expect(
      await direct({
        gate: 1,
        decision: 'auto_approved',
        requester: null,
        actor: null,
        auto: true,
      }),
    ).toBeUndefined();
  });

  it('stores the requester the service checked, so the database can re-check it later', async () => {
    const requester = newId();
    const approver = newId();
    const subjectId = newId();
    await makeRepo(tenantA).record(input({ subjectId, requesterId: requester, actorId: approver }));
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.query<{ requester_id: string; actor_id: string }>(
        'SELECT requester_id, actor_id FROM authz_gate_decisions WHERE subject_id = $1',
        [subjectId],
      ),
    );
    expect(rows.rows).toEqual([{ requester_id: requester, actor_id: approver }]);
  });
});
