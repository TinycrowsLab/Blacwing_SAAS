// Gate 2 exceptions against the REAL migrations on Postgres 16 (Testcontainers) as bw_app: RLS isolation,
// SoD and the destructive block at the database layer (raw SQL, bypassing the service), the double-decision
// and timeout-vs-human races, exactly one gate_decisions row per terminal transition, and atomicity with
// the audit outbox. The rules without a database are in gate2.test.ts and @blackwing/domain.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Gate2AlreadyDecidedError } from '@blackwing/domain';
import { NotFoundError, TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, type Database, migrateDatabase } from './index.js';
import { gate2Service, type Gate2AuditEvent, type Gate2Service } from './gate2.js';
import { withOutbox } from './outbox.js';
import { type TenantTx, withTenant } from './with-tenant.js';

let db: PostgresHandle;
let app: Database;
const tenantA = newId();
const tenantB = newId();
const REQUESTER = newId();
const PLAN_APPROVER = newId();
const ONCALL = newId();
const OTHER_ONCALL = newId();
const silent = { child: () => ({ info: () => undefined }) } as never;

/** Audit sink used in production wiring shape: an `audit.event` outbox row in the same transaction. */
const outboxSink = (tx: TenantTx, event: Gate2AuditEvent) =>
  withOutbox(
    tx,
    [
      {
        type: 'audit.event',
        aggregateType: 'run',
        aggregateId: event.exception.runId,
        payload: { action: event.action, exceptionId: event.exception.id },
        dedupeKey: `${event.action}:${event.exception.id}`,
      },
    ],
    { logger: silent },
  ).then(() => undefined);

function asTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx, service: Gate2Service) => Promise<T>,
  audit = outboxSink,
): Promise<T> {
  return withTenant(app, tenantId, (tx) => fn(tx, gate2Service(tx, { audit, logger: silent })));
}

const create = (over: Record<string, unknown> = {}) => ({
  runId: newId(),
  sessionId: 'sess-1',
  toolName: 'http.request',
  proposedAction: { method: 'POST', url: 'https://app.example.test/orders' },
  envelopeReason: 'no permit matched',
  intrusiveness: 'state_changing',
  requesterId: REQUESTER,
  planApproverId: PLAN_APPROVER,
  timeoutAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  idempotencyKey: newId(),
  ...over,
});

const person = (id: string) => ({ kind: 'user', id }) as const;
const system = { kind: 'system', id: 'gate2-timer' } as const;

async function openException(tenantId = tenantA, over: Record<string, unknown> = {}) {
  return (await asTenant(tenantId, (_tx, service) => service.create(create(over)))).exception;
}

/** Postgres error code of a rejected promise (23514 check, 42501 privilege / RLS, 40001 serialization...). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      if (cause instanceof pg.DatabaseError) return cause.code;
    }
    return 'not-a-database-error';
  }
  return undefined;
}

async function decisionRows(tenantId: string, exceptionId: string) {
  return db.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query(
      'SELECT gate, decision, actor_id, auto, reason FROM gate_decisions WHERE subject_id = $1',
      [exceptionId],
    );
    return rows as { gate: number; decision: string; actor_id: string | null; auto: boolean }[];
  });
}

async function stateOf(tenantId: string, id: string) {
  return db.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query(
      'SELECT state, state_version FROM gate2_exceptions WHERE id = $1',
      [id],
    );
    return rows[0] as { state: string; state_version: number } | undefined;
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  app = createDatabase(db.appPool);
});

afterAll(async () => {
  await db.stop();
});

describe('migration and RLS isolation', () => {
  it('creates an exception that only its own tenant can see or decide', async () => {
    const exception = await openException(tenantA);
    expect(exception).toMatchObject({ tenantId: tenantA, state: 'pending', stateVersion: 0 });

    expect(await asTenant(tenantB, (_tx, service) => service.get(exception.id))).toBeUndefined();
    await expect(
      asTenant(tenantB, (_tx, service) =>
        service.decide({
          exceptionId: exception.id,
          event: 'deny',
          actor: person(ONCALL),
          reason: 'x',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await stateOf(tenantA, exception.id))?.state).toBe('pending');
    expect(await stateOf(tenantB, exception.id)).toBeUndefined();
  });

  it('cannot insert a row for another tenant (RLS WITH CHECK)', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO gate2_exceptions (id, tenant_id, run_id, session_id, tool_name, proposed_action,
             envelope_reason, intrusiveness, timeout_at, idempotency_key)
           VALUES ($1, $2, $1, 's', 't', '{}', 'r', 'passive', now() + interval '1 hour', 'k')`,
          [newId(), tenantA],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('fails closed without a tenant context', async () => {
    await expect(
      app.transaction((tx) =>
        gate2Service(tx as TenantTx, { audit: outboxSink, logger: silent }).create(create()),
      ),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});

describe('idempotency', () => {
  it('returns the existing exception for a repeated key, with no duplicate row or audit event', async () => {
    const input = create();
    const first = await asTenant(tenantA, (_tx, service) => service.create(input));
    const second = await asTenant(tenantA, (_tx, service) => service.create(input));
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, exception: { id: first.exception.id } });
    const counts = await db.withTenant(tenantA, async (tx) => ({
      rows: (
        await tx.query(
          'SELECT count(*)::int AS n FROM gate2_exceptions WHERE idempotency_key = $1',
          [input.idempotencyKey],
        )
      ).rows[0],
      audit: (
        await tx.query('SELECT count(*)::int AS n FROM outbox WHERE dedupe_key = $1', [
          `gate2.exception.created:${first.exception.id}`,
        ])
      ).rows[0],
    }));
    expect(counts.rows).toEqual({ n: 1 });
    expect(counts.audit).toEqual({ n: 1 });
  });

  it('keeps keys per tenant: the same key opens one exception in each tenant', async () => {
    const input = create({ idempotencyKey: 'shared-key' });
    const a = await asTenant(tenantA, (_tx, service) => service.create(input));
    const b = await asTenant(tenantB, (_tx, service) => service.create(input));
    expect(a.created && b.created).toBe(true);
    expect(a.exception.id).not.toBe(b.exception.id);
  });
});

describe('every terminal transition writes exactly one gate_decisions row (and one audit event)', () => {
  it.each([
    ['approve', 'approved_once', 'approved', false],
    ['deny', 'denied', 'denied', false],
    ['supersede', 'superseded', 'denied', true],
  ] as const)('%s -> %s', async (event, state, decision, auto) => {
    const exception = await openException();
    const result = await asTenant(tenantA, (_tx, service) =>
      service.decide({
        exceptionId: exception.id,
        event,
        actor: auto ? system : person(ONCALL),
        reason: 'integration test',
      }),
    );
    expect(result).toMatchObject({ applied: true, exception: { state, stateVersion: 1 } });
    const rows = await decisionRows(tenantA, exception.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gate: 2, decision, auto, actor_id: auto ? null : ONCALL });
    const audit = await db.withTenant(
      tenantA,
      async (tx) =>
        (
          await tx.query('SELECT count(*)::int AS n FROM outbox WHERE dedupe_key = $1', [
            `gate2.decision.recorded:${exception.id}`,
          ])
        ).rows[0],
    );
    expect(audit).toEqual({ n: 1 });
  });

  it('time_out -> timed_out once the timeout has elapsed by the database clock, auto and denied', async () => {
    const exception = await openException(tenantA, {
      timeoutAt: new Date(Date.now() + 700).toISOString(),
    });
    // Too early: the machine refuses the timer.
    await expect(
      asTenant(tenantA, (_tx, service) =>
        service.decide({ exceptionId: exception.id, event: 'time_out', actor: system }),
      ),
    ).rejects.toMatchObject({ code: 'GATE2_ILLEGAL_TRANSITION' });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const result = await asTenant(tenantA, (_tx, service) =>
      service.decide({ exceptionId: exception.id, event: 'time_out', actor: system }),
    );
    expect(result).toMatchObject({ applied: true, exception: { state: 'timed_out' } });
    const rows = await decisionRows(tenantA, exception.id);
    expect(rows).toEqual([
      expect.objectContaining({ gate: 2, decision: 'denied', auto: true, actor_id: null }),
    ]);
  });

  it('an approval after the timeout is refused and the exception stays pending (default deny)', async () => {
    const exception = await openException(tenantA, {
      timeoutAt: new Date(Date.now() + 600).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(
      asTenant(tenantA, (_tx, service) =>
        service.decide({
          exceptionId: exception.id,
          event: 'approve',
          actor: person(ONCALL),
          reason: 'late',
        }),
      ),
    ).rejects.toMatchObject({ code: 'GATE2_ILLEGAL_TRANSITION' });
    expect((await stateOf(tenantA, exception.id))?.state).toBe('pending');
    expect(await decisionRows(tenantA, exception.id)).toHaveLength(0);
  });
});

describe('separation of duties and the destructive block, at the service layer', () => {
  it.each([
    ['the requester', REQUESTER],
    ['the plan approver', PLAN_APPROVER],
  ] as const)('rejects approval by %s', async (_label, actor) => {
    const exception = await openException();
    await expect(
      asTenant(tenantA, (_tx, service) =>
        service.decide({
          exceptionId: exception.id,
          event: 'approve',
          actor: person(actor),
          reason: 'self-approval',
        }),
      ),
    ).rejects.toMatchObject({ code: 'GATE2_SOD_VIOLATION' });
    expect((await stateOf(tenantA, exception.id))?.state).toBe('pending');
    expect(await decisionRows(tenantA, exception.id)).toHaveLength(0);
  });

  it('rejects approving a destructive exception', async () => {
    const exception = await openException(tenantA, { intrusiveness: 'destructive' });
    await expect(
      asTenant(tenantA, (_tx, service) =>
        service.decide({
          exceptionId: exception.id,
          event: 'approve',
          actor: person(ONCALL),
          reason: 'please',
        }),
      ),
    ).rejects.toMatchObject({ code: 'GATE2_DESTRUCTIVE_FORBIDDEN' });
    expect((await stateOf(tenantA, exception.id))?.state).toBe('pending');
  });
});

describe('separation of duties and the destructive block, at the DATABASE layer (raw SQL)', () => {
  const approveSql = `UPDATE gate2_exceptions SET state = 'approved_once', decided_by = $2,
    decided_at = clock_timestamp(), state_version = 1 WHERE id = $1`;

  it('rejects an approval by the requester', async () => {
    const exception = await openException();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query(approveSql, [exception.id, REQUESTER])),
    );
    expect(code).toBe('23514');
    expect((await stateOf(tenantA, exception.id))?.state).toBe('pending');
  });

  it('rejects an approval by the plan approver', async () => {
    const exception = await openException();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query(approveSql, [exception.id, PLAN_APPROVER])),
    );
    expect(code).toBe('23514');
  });

  it('rejects approving a destructive exception, even with a third approver', async () => {
    const exception = await openException(tenantA, { intrusiveness: 'destructive' });
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query(approveSql, [exception.id, ONCALL])),
    );
    expect(code).toBe('23514');
  });

  it('rejects a backdated decision instant, a skipped version and a late approval', async () => {
    const exception = await openException();
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `UPDATE gate2_exceptions SET state = 'denied', decided_by = $2, decided_at = now() - interval '1 day', state_version = 1 WHERE id = $1`,
            [exception.id, ONCALL],
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `UPDATE gate2_exceptions SET state = 'denied', decided_by = $2, decided_at = clock_timestamp(), state_version = 7 WHERE id = $1`,
            [exception.id, ONCALL],
          ),
        ),
      ),
    ).toBe('40001');
    const short = await openException(tenantA, {
      timeoutAt: new Date(Date.now() + 400).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => tx.query(approveSql, [short.id, ONCALL]))),
    ).toBe('23514');
  });

  it('rejects any change to a decided exception and to its identity columns', async () => {
    const exception = await openException();
    await asTenant(tenantA, (_tx, service) =>
      service.decide({
        exceptionId: exception.id,
        event: 'deny',
        actor: person(ONCALL),
        reason: 'no',
      }),
    );
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `UPDATE gate2_exceptions SET state = 'approved_once', decided_by = $2, decided_at = clock_timestamp(), state_version = 2 WHERE id = $1`,
            [exception.id, OTHER_ONCALL],
          ),
        ),
      ),
    ).toBe('23001');
    const fresh = await openException();
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`UPDATE gate2_exceptions SET tool_name = 'other' WHERE id = $1`, [fresh.id]),
        ),
      ),
    ).toBe('23001');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`DELETE FROM gate2_exceptions WHERE id = $1`, [fresh.id]),
        ),
      ),
    ).toBe('42501');
  });

  it('refuses a terminal transition that has no gate_decisions row at commit', async () => {
    const exception = await openException();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `UPDATE gate2_exceptions SET state = 'denied', decided_by = $2, decided_at = clock_timestamp(), state_version = 1 WHERE id = $1`,
          [exception.id, ONCALL],
        ),
      ),
    );
    expect(code).toBe('23514');
    expect((await stateOf(tenantA, exception.id))?.state).toBe('pending');
  });

  it('refuses to create an exception that is not pending', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO gate2_exceptions (id, tenant_id, run_id, session_id, tool_name, proposed_action,
             envelope_reason, intrusiveness, timeout_at, idempotency_key, state, decided_by, decided_at)
           VALUES ($1, $2, $1, 's', 't', '{}', 'r', 'passive', now() + interval '1 hour', 'born-denied',
             'denied', $3, now())`,
          [newId(), tenantA, ONCALL],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('keeps gate_decisions append-only for the app role', async () => {
    const exception = await openException();
    await asTenant(tenantA, (_tx, service) =>
      service.decide({
        exceptionId: exception.id,
        event: 'deny',
        actor: person(ONCALL),
        reason: 'no',
      }),
    );
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`UPDATE gate_decisions SET reason = 'edited' WHERE subject_id = $1`, [
            exception.id,
          ]),
        ),
      ),
    ).toBe('42501');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`DELETE FROM gate_decisions WHERE subject_id = $1`, [exception.id]),
        ),
      ),
    ).toBe('42501');
    // Even the owner cannot: the trigger rejects UPDATE and DELETE for every role.
    expect(
      await pgCode(
        db.ownerPool.query(`UPDATE gate_decisions SET reason = 'edited' WHERE subject_id = $1`, [
          exception.id,
        ]),
      ),
    ).toBe('23001');
  });

  it('allows only one Gate 2 decision row per exception', async () => {
    const exception = await openException();
    await asTenant(tenantA, (_tx, service) =>
      service.decide({
        exceptionId: exception.id,
        event: 'deny',
        actor: person(ONCALL),
        reason: 'no',
      }),
    );
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO gate_decisions (tenant_id, gate, subject_type, subject_id, decision, actor_id, reason, auto)
           VALUES ($1, 2, 'gate2_exception', $2, 'denied', $3, 'again', false)`,
          [tenantA, exception.id, ONCALL],
        ),
      ),
    );
    expect(code).toBe('23505');
  });
});

describe('races: first committed wins', () => {
  it('two approvers at once: exactly one wins, the other gets GATE2_ALREADY_DECIDED, one decision row', async () => {
    const exception = await openException();
    const attempt = (actor: string, event: 'approve' | 'deny') =>
      asTenant(tenantA, (_tx, service) =>
        service.decide({
          exceptionId: exception.id,
          event,
          actor: person(actor),
          reason: `by ${actor}`,
        }),
      ).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const outcomes = await Promise.all([attempt(ONCALL, 'approve'), attempt(OTHER_ONCALL, 'deny')]);
    const wins = outcomes.filter((outcome) => outcome.ok);
    const losses = outcomes.filter((outcome) => !outcome.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as { error: unknown }).error).toBeInstanceOf(Gate2AlreadyDecidedError);
    expect((losses[0] as { error: { code: string } }).error.code).toBe('GATE2_ALREADY_DECIDED');
    expect((await stateOf(tenantA, exception.id))?.state_version).toBe(1);
    expect(await decisionRows(tenantA, exception.id)).toHaveLength(1);
  });

  it('timeout and a human decision at once: one decision row; the loser is a no-op or already-decided', async () => {
    const exception = await openException(tenantA, {
      timeoutAt: new Date(Date.now() + 500).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const [timer, human] = await Promise.all([
      asTenant(tenantA, (_tx, service) =>
        service.decide({ exceptionId: exception.id, event: 'time_out', actor: system }),
      ).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      asTenant(tenantA, (_tx, service) =>
        service.decide({
          exceptionId: exception.id,
          event: 'deny',
          actor: person(ONCALL),
          reason: 'no',
        }),
      ).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    const final = await stateOf(tenantA, exception.id);
    expect(['timed_out', 'denied']).toContain(final?.state);
    expect(final?.state_version).toBe(1);
    expect(await decisionRows(tenantA, exception.id)).toHaveLength(1);
    // Exactly one of the two applied a change; the timer's loss is a quiet no-op.
    if (final?.state === 'timed_out') {
      expect(timer).toMatchObject({ ok: true, result: { applied: true } });
      expect(human.ok).toBe(false);
    } else {
      expect(human).toMatchObject({ ok: true, result: { applied: true } });
      expect(timer).toMatchObject({ ok: true, result: { applied: false } });
    }
  });
});

describe('audit atomicity', () => {
  it('rolls the exception back when the audit sink fails', async () => {
    const input = create();
    await expect(
      asTenant(
        tenantA,
        (_tx, service) => service.create(input),
        () => Promise.reject(new Error('ledger unavailable')),
      ),
    ).rejects.toThrow('ledger unavailable');
    const { rows } = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT 1 FROM gate2_exceptions WHERE idempotency_key = $1', [input.idempotencyKey]),
    );
    expect(rows).toHaveLength(0);
  });

  it('rolls the decision and its gate_decisions row back when the audit sink fails', async () => {
    const exception = await openException();
    await expect(
      asTenant(
        tenantA,
        (_tx, service) =>
          service.decide({
            exceptionId: exception.id,
            event: 'deny',
            actor: person(ONCALL),
            reason: 'no',
          }),
        () => Promise.reject(new Error('ledger unavailable')),
      ),
    ).rejects.toThrow('ledger unavailable');
    expect((await stateOf(tenantA, exception.id))?.state).toBe('pending');
    expect(await decisionRows(tenantA, exception.id)).toHaveLength(0);
  });
});
