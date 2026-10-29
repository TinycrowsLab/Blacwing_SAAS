// Production `Gate2Store` over the tenant-scoped `gate_decisions` table (CONTEXT_PACK §4.2, F13). The port speaks
// ISO strings and the request object; the database speaks Dates and flat columns. This module only translates
// between the two and refuses a timestamp it cannot read, so a bad value fails closed instead of being stored.

import { newId } from '@blackwing/ids';

import type { Gate2Row, Gate2Store } from './ports.js';
import type { Gate2Request } from './types.js';
import type { PgGate2DecisionStore, StoredGate2Decision } from '@blackwing/db';

function toDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`gate 2 ${field} is not a timestamp`);
  return date;
}

function toRow(stored: StoredGate2Decision): Gate2Row {
  return {
    decisionId: stored.decisionId,
    request: {
      kind: stored.kind,
      dedupeKey: stored.dedupeKey,
      subtaskId: stored.subtaskId,
      sessionId: stored.sessionId,
      toolUseId: stored.toolUseId,
      summary: stored.summary,
      target: stored.target,
    },
    status: stored.status,
    requestedAt: stored.requestedAt.toISOString(),
    timeoutAt: stored.timeoutAt.toISOString(),
    decidedBy: stored.decidedBy,
    decidedAt: stored.decidedAt?.toISOString() ?? null,
    reason: stored.reason,
    auto: stored.auto,
  };
}

/** Adapts the `gate_decisions` store to the execution phase's `Gate2Store` port. */
export function createGate2Store(
  store: PgGate2DecisionStore,
  newDecisionId: () => string = newId,
): Gate2Store {
  return {
    async open(tenantId, runId, request: Gate2Request, timeoutAt, requestedAt) {
      const { row, created } = await store.open(tenantId, {
        decisionId: newDecisionId(),
        runId,
        kind: request.kind,
        dedupeKey: request.dedupeKey,
        subtaskId: request.subtaskId,
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        summary: request.summary,
        target: request.target,
        requestedAt: toDate(requestedAt, 'requestedAt'),
        timeoutAt: toDate(timeoutAt, 'timeoutAt'),
      });
      return { row: toRow(row), created };
    },

    async get(tenantId, decisionId) {
      const row = await store.get(tenantId, decisionId);
      return row === null ? null : toRow(row);
    },

    async decide(tenantId, decisionId, outcome) {
      return store.decide(tenantId, decisionId, {
        status: outcome.decision,
        decidedBy: outcome.decidedBy,
        decidedAt: toDate(outcome.decidedAt, 'decidedAt'),
        reason: outcome.reason,
        auto: outcome.auto,
      });
    },

    async listPending(tenantId, runId) {
      return (await store.listPending(tenantId, runId)).map((row) => toRow(row));
    },
  };
}
