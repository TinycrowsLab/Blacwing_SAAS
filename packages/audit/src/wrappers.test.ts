import { describe, expect, it } from 'vitest';

import { createAuditEmitter } from './emit.js';
import {
  MemoryLedger,
  MemoryOutbox,
  NULL_TX,
  RUN_ID,
  TENANT_A,
  verifyEvents,
} from './test-support.js';
import {
  auditConfigChange,
  auditExport,
  auditGateDecision,
  auditLogin,
  configChangeInput,
  exportInput,
  gateDecisionInput,
  loginInput,
} from './wrappers.js';

const base = {
  tenantId: TENANT_A,
  actor: { type: 'user', id: 'user-1' } as const,
  target: { type: 'run', id: RUN_ID } as const,
};

describe('wrappers', () => {
  it.each([
    [1, 'approved', 'gate1.decided', 'success'],
    [2, 'denied', 'gate2.decided', 'denied'],
    [2, 'timed_out', 'gate2.decided', 'denied'],
    [3, 'approved', 'gate3.released', 'success'],
  ] as const)('gate %i %s maps to %s / %s', (gate, decision, action, outcome) => {
    const built = gateDecisionInput({ ...base, gate, decision });
    expect(built).toMatchObject({ action, outcome, metadata: { gate, decision } });
  });

  it('keeps caller metadata but never lets it override gate and decision', () => {
    const built = gateDecisionInput({
      ...base,
      gate: 2,
      decision: 'denied',
      metadata: { gate: 99, decision: 'approved', extra: 1 },
    });
    expect(built.metadata).toEqual({ gate: 2, decision: 'denied', extra: 1 });
  });

  it('maps login, export and config change', () => {
    expect(loginInput({ ...base, succeeded: false })).toMatchObject({
      action: 'auth.login',
      outcome: 'failure',
    });
    expect(exportInput({ ...base, outcome: 'success' }).action).toBe('export.generated');
    expect(configChangeInput({ ...base, outcome: 'denied' }).action).toBe('config.changed');
  });

  it('delivers in the transaction when given one, through the outbox otherwise', async () => {
    const ledger = new MemoryLedger();
    const outbox = new MemoryOutbox();
    const emitter = createAuditEmitter({ outbox, chainStore: () => ledger.store() });
    await auditGateDecision({ emitter, tx: NULL_TX }, { ...base, gate: 2, decision: 'timed_out' });
    await auditLogin({ emitter, tx: NULL_TX }, { ...base, succeeded: true });
    expect(verifyEvents(ledger.forTenant(TENANT_A))).toEqual([1, 2]);
    expect(outbox.messages).toHaveLength(0);
    await auditExport({ emitter }, { ...base, outcome: 'success' });
    await auditConfigChange({ emitter }, { ...base, outcome: 'success', dedupeKey: 'cfg-1' });
    expect(outbox.messages.map((m) => m.aggregateType)).toEqual(['run', 'run']);
  });
});
