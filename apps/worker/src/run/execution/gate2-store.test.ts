import { describe, expect, it } from 'vitest';

import { createGate2Store } from './gate2-store.js';

import type { Gate2Request } from './types.js';
import type { OpenGate2Input, PgGate2DecisionStore, StoredGate2Decision } from '@blackwing/db';

const TENANT_A = '0190a000-0000-7000-8000-000000000001';
const TENANT_B = '0190a000-0000-7000-8000-000000000002';
const RUN = '0190a000-0000-7000-8000-0000000000b1';
const REQUESTED = '2026-10-29T10:00:00.000Z';
const TIMEOUT = '2026-10-29T10:30:00.000Z';

const REQUEST: Gate2Request = {
  kind: 'tool_deferred',
  dedupeKey: 'tool:toolu_1',
  subtaskId: 'subtask-1',
  sessionId: 'session-1',
  toolUseId: 'toolu_1',
  summary: 'http_request outside the envelope',
  target: null,
};

/** In-memory stand-in with the same semantics as the Postgres store: per-tenant dedupe, CAS from pending. */
class MemoryPgStore implements PgGate2DecisionStore {
  readonly rows = new Map<string, StoredGate2Decision>();

  open(tenantId: string, input: OpenGate2Input) {
    const existing = [...this.rows.values()].find(
      (r) => r.tenantId === tenantId && r.dedupeKey === input.dedupeKey,
    );
    if (existing !== undefined) return Promise.resolve({ row: existing, created: false });
    const row: StoredGate2Decision = {
      decisionId: input.decisionId,
      tenantId,
      runId: input.runId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      subtaskId: input.subtaskId,
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      summary: input.summary,
      target: input.target,
      status: 'pending',
      requestedAt: input.requestedAt,
      timeoutAt: input.timeoutAt,
      decidedBy: null,
      decidedAt: null,
      reason: null,
      auto: false,
    };
    this.rows.set(input.decisionId, row);
    return Promise.resolve({ row, created: true });
  }

  get(tenantId: string, decisionId: string) {
    const row = this.rows.get(decisionId);
    return Promise.resolve(row?.tenantId === tenantId ? row : null);
  }

  async decide(
    tenantId: string,
    decisionId: string,
    outcome: Parameters<PgGate2DecisionStore['decide']>[2],
  ) {
    const row = await this.get(tenantId, decisionId);
    if (row?.status !== 'pending') return false;
    this.rows.set(decisionId, {
      ...row,
      status: outcome.status,
      decidedBy: outcome.decidedBy,
      decidedAt: outcome.decidedAt,
      reason: outcome.reason,
      auto: outcome.auto,
    });
    return true;
  }

  listPending(tenantId: string, runId: string) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) => r.tenantId === tenantId && r.runId === runId && r.status === 'pending',
      ),
    );
  }
}

describe('gate 2 store adapter', () => {
  it('opens a pending row and maps it to the port shape with ISO timestamps', async () => {
    const gates = createGate2Store(new MemoryPgStore(), () => 'decision-1');
    const opened = await gates.open(TENANT_A, RUN, REQUEST, TIMEOUT, REQUESTED);
    expect(opened.created).toBe(true);
    expect(opened.row).toMatchObject({
      decisionId: 'decision-1',
      status: 'pending',
      requestedAt: REQUESTED,
      timeoutAt: TIMEOUT,
      decidedBy: null,
      decidedAt: null,
      auto: false,
      request: REQUEST,
    });
  });

  it('returns the existing decision for the same dedupe key', async () => {
    let next = 0;
    const gates = createGate2Store(new MemoryPgStore(), () => `decision-${++next}`);
    const first = await gates.open(TENANT_A, RUN, REQUEST, TIMEOUT, REQUESTED);
    const again = await gates.open(TENANT_A, RUN, REQUEST, TIMEOUT, REQUESTED);
    expect(again).toMatchObject({ created: false, row: { decisionId: first.row.decisionId } });
  });

  it('decides once: an approval resolves the row, a later timeout denial changes nothing', async () => {
    const gates = createGate2Store(new MemoryPgStore(), () => 'decision-1');
    await gates.open(TENANT_A, RUN, REQUEST, TIMEOUT, REQUESTED);
    const approved = await gates.decide(TENANT_A, 'decision-1', {
      decision: 'approved',
      decidedBy: '0190a000-0000-7000-8000-0000000000a1',
      decidedAt: '2026-10-29T10:05:00.000Z',
      reason: 'in scope',
      auto: false,
    });
    const timedOut = await gates.decide(TENANT_A, 'decision-1', {
      decision: 'denied',
      decidedBy: null,
      decidedAt: TIMEOUT,
      reason: 'gate 2 timeout',
      auto: true,
    });
    expect(approved).toBe(true);
    expect(timedOut).toBe(false);
    expect(await gates.get(TENANT_A, 'decision-1')).toMatchObject({
      status: 'approved',
      auto: false,
    });
  });

  it("does not expose another tenant's decision", async () => {
    const gates = createGate2Store(new MemoryPgStore(), () => 'decision-1');
    await gates.open(TENANT_A, RUN, REQUEST, TIMEOUT, REQUESTED);
    expect(await gates.get(TENANT_B, 'decision-1')).toBeNull();
    expect(await gates.listPending(TENANT_B, RUN)).toEqual([]);
    expect(
      await gates.decide(TENANT_B, 'decision-1', {
        decision: 'approved',
        decidedBy: '0190a000-0000-7000-8000-0000000000a1',
        decidedAt: REQUESTED,
        reason: 'cross-tenant',
        auto: false,
      }),
    ).toBe(false);
  });

  it('refuses a timestamp it cannot read instead of storing it', async () => {
    const gates = createGate2Store(new MemoryPgStore(), () => 'decision-1');
    await expect(gates.open(TENANT_A, RUN, REQUEST, 'not-a-date', REQUESTED)).rejects.toThrow(
      'gate 2 timeoutAt is not a timestamp',
    );
  });
});
