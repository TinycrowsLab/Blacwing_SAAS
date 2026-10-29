// Gate 2 decisions (CONTEXT_PACK §4.2, F13): the compare-and-set decision, idempotent open, tenant isolation,
// the CHECK constraints and the runtime role's privileges, against the real migrations on Postgres 16
// (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createPgGate2DecisionStore, type OpenGate2Input } from './gate-decisions.js';
import { createDatabase, migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const approverA = newId();
const requestedAt = new Date('2026-10-29T10:00:00Z');
const timeoutAt = new Date('2026-10-29T10:30:00Z');

/** Postgres error code of a rejected promise (23514 check_violation, 42501 insufficient privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    // Drizzle and the transaction wrapper add layers; walk the `cause` chain to the driver error.
    for (let link: unknown = error; link !== undefined; link = (link as Error).cause) {
      if (link instanceof pg.DatabaseError) return link.code;
    }
    return 'not-a-database-error';
  }
  return undefined;
}

function store() {
  return createPgGate2DecisionStore(createDatabase(db.appPool));
}

function openInput(overrides: Partial<OpenGate2Input> = {}): OpenGate2Input {
  return {
    decisionId: newId(),
    runId: newId(),
    kind: 'tool_deferred',
    dedupeKey: `tool:${newId()}`,
    subtaskId: 'subtask-1',
    sessionId: 'session-1',
    toolUseId: 'toolu_1',
    summary: 'http_request to a host outside the envelope',
    target: null,
    requestedAt,
    timeoutAt,
    ...overrides,
  };
}

const humanApprove = (decidedBy: string = newId()) => ({
  status: 'approved' as const,
  decidedBy,
  decidedAt: new Date('2026-10-29T10:05:00Z'),
  reason: 'in scope for the engagement',
  auto: false,
});

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('gate 2 decision store', () => {
  it('opens a pending gate 2 row and reads it back for the same tenant', async () => {
    const input = openInput();
    const { row, created } = await store().open(tenantA, input);
    expect(created).toBe(true);
    expect(row).toMatchObject({
      decisionId: input.decisionId,
      tenantId: tenantA,
      runId: input.runId,
      kind: 'tool_deferred',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      auto: false,
      toolUseId: 'toolu_1',
    });
    expect(await store().get(tenantA, input.decisionId)).toMatchObject({ status: 'pending' });
  });

  it('returns the existing row for the same dedupe key instead of opening a second decision', async () => {
    const first = openInput({ dedupeKey: 'dup-key' });
    const created = await store().open(tenantA, first);
    const again = await store().open(tenantA, { ...first, decisionId: newId() });
    expect(again.created).toBe(false);
    expect(again.row.decisionId).toBe(created.row.decisionId);
  });

  it('decides a pending row once: a human approval wins, a later decision changes nothing', async () => {
    const { row } = await store().open(tenantA, openInput());
    expect(await store().decide(tenantA, row.decisionId, humanApprove(approverA))).toBe(true);
    expect(
      await store().decide(tenantA, row.decisionId, {
        status: 'denied',
        decidedBy: null,
        decidedAt: new Date('2026-10-29T10:30:00Z'),
        reason: 'timed out',
        auto: true,
      }),
    ).toBe(false);
    expect(await store().get(tenantA, row.decisionId)).toMatchObject({
      status: 'approved',
      decidedBy: approverA,
      auto: false,
    });
  });

  it('records a system timeout denial with no approver', async () => {
    const { row } = await store().open(tenantA, openInput());
    const denied = await store().decide(tenantA, row.decisionId, {
      status: 'denied',
      decidedBy: null,
      decidedAt: timeoutAt,
      reason: 'gate 2 timeout',
      auto: true,
    });
    expect(denied).toBe(true);
    expect(await store().get(tenantA, row.decisionId)).toMatchObject({
      status: 'denied',
      decidedBy: null,
      auto: true,
    });
  });

  it('lists only the pending rows of one run, oldest first', async () => {
    const runId = newId();
    const older = await store().open(tenantA, openInput({ runId, requestedAt }));
    const newer = await store().open(
      tenantA,
      openInput({ runId, requestedAt: new Date('2026-10-29T10:01:00Z') }),
    );
    await store().decide(tenantA, older.row.decisionId, humanApprove());
    const pending = await store().listPending(tenantA, runId);
    expect(pending.map((r) => r.decisionId)).toEqual([newer.row.decisionId]);
  });
});

describe('tenant isolation', () => {
  it("tenant B cannot read or decide tenant A's gate 2 row", async () => {
    const { row } = await store().open(tenantA, openInput());
    expect(await store().get(tenantB, row.decisionId)).toBeNull();
    expect(await store().decide(tenantB, row.decisionId, humanApprove())).toBe(false);
    expect(await store().get(tenantA, row.decisionId)).toMatchObject({ status: 'pending' });
  });

  it("tenant B's pending list for a run never includes tenant A's rows", async () => {
    const runId = newId();
    await store().open(tenantA, openInput({ runId }));
    expect(await store().listPending(tenantB, runId)).toEqual([]);
  });

  it('a row cannot be inserted under another tenant context', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO gate_decisions (decision_id, tenant_id, run_id, gate, kind, dedupe_key, summary, requested_at, timeout_at)
           VALUES ($1, $2, $3, 2, 'tool_deferred', 'cross', 's', now(), now())`,
          [newId(), tenantA, newId()],
        ),
      ),
    );
    expect(code).toBe('42501');
  });
});

describe('database constraints and privileges', () => {
  it('refuses an unknown kind and a gate outside 1..3', async () => {
    const base = (kind: string, gate: number) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO gate_decisions (decision_id, tenant_id, run_id, gate, kind, dedupe_key, summary, requested_at, timeout_at)
           VALUES ($1, $2, $3, $4, $5, $6, 's', now(), now())`,
          [newId(), tenantA, newId(), gate, kind, newId()],
        ),
      );
    expect(await pgCode(base('free_for_all', 2))).toBe('23514');
    expect(await pgCode(base('tool_deferred', 4))).toBe('23514');
  });

  it('refuses a decided row without an approver or a system decision', async () => {
    const { row } = await store().open(tenantA, openInput());
    const code = await pgCode(
      store().decide(tenantA, row.decisionId, {
        status: 'approved',
        decidedBy: null,
        decidedAt: new Date(),
        reason: 'no approver',
        auto: false,
      }),
    );
    expect(code).toBe('23514');
    expect(await store().get(tenantA, row.decisionId)).toMatchObject({ status: 'pending' });
  });

  it('the runtime role cannot delete a decision row', async () => {
    const { row } = await store().open(tenantA, openInput());
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM gate_decisions WHERE decision_id = $1', [row.decisionId]),
      ),
    );
    expect(code).toBe('42501');
  });
});
