import { describe, expect, it } from 'vitest';

import { createKillActivities, type KillActivityDeps } from './activities.js';
import {
  ackAll,
  FakeGateway,
  FakeKeyGateway,
  FakeReversalJournal,
  FakeWorkflowCanceller,
  KILL_ID,
  makeDeps,
  MemoryKillRepo,
  RUN_ID,
  runIdentity,
  T0,
  TENANT,
} from './testing.js';

const ref = { tenantId: TENANT, killEventId: KILL_ID };
const KEYS = ['key-1', 'key-2'];
const WFS = ['wf-run', 'wf-session-1'];

function setup(overrides: Partial<KillActivityDeps> = {}) {
  const repo = new MemoryKillRepo();
  const made = makeDeps(repo, new FakeGateway((i) => ackAll(i)), overrides);
  return { repo, ...made, acts: createKillActivities(made.deps) };
}

describe('revokeKeys (stage 3)', () => {
  it('revokes the keys and records keys_revoked_at', async () => {
    const keys = new FakeKeyGateway();
    const { acts, repo, metrics } = setup({ keys });
    const result = await acts.revokeKeys({ ...ref, keyIds: KEYS });
    expect(result.outcome).toBe('revoked');
    expect(keys.calls).toEqual([{ keyIds: KEYS }]);
    expect(repo.event.keysRevokedAt).toEqual(T0);
    expect(repo.event.affected.keys).toBe(2);
    expect(metrics.keyCount).toBe(2);
  });

  it('treats already_revoked (expired) as an idempotent success', async () => {
    const keys = new FakeKeyGateway((ids) =>
      ids.map((keyId) => ({ keyId, outcome: 'already_revoked' as const })),
    );
    const { acts } = setup({ keys });
    expect((await acts.revokeKeys({ ...ref, keyIds: KEYS })).outcome).toBe('revoked');
  });

  it('retries only the keys that failed', async () => {
    const keys = new FakeKeyGateway((ids, call) =>
      ids.map((keyId) => ({
        keyId,
        outcome: keyId === 'key-2' && call === 1 ? ('failed' as const) : ('revoked' as const),
      })),
    );
    const { acts } = setup({ keys });
    const result = await acts.revokeKeys({ ...ref, keyIds: KEYS });
    expect(result.outcome).toBe('revoked');
    expect(keys.calls).toEqual([{ keyIds: KEYS }, { keyIds: ['key-2'] }]);
  });

  it('gateway down: stamps at the deadline, marks partially_halted and alerts (expiry is the backstop)', async () => {
    const keys = new FakeKeyGateway(() => new Error('unreachable'));
    const { acts, repo, metrics } = setup({ keys, keyDeadlineMs: 1_000 });
    const result = await acts.revokeKeys({ ...ref, keyIds: KEYS });
    expect(result.outcome).toBe('partially_halted');
    expect(repo.event.keysRevokedAt).not.toBeNull();
    expect(repo.event.status).toBe('partially_halted');
    expect(metrics.partial).toBe(1);
    expect(repo.event.affected.keys).toBe(0);
  });

  it('ignores acks for keys that were not asked about (no cross-scope credit)', async () => {
    const keys = new FakeKeyGateway(() => [{ keyId: 'other', outcome: 'revoked' }]);
    const { acts } = setup({ keys, keyDeadlineMs: 500 });
    expect((await acts.revokeKeys({ ...ref, keyIds: KEYS })).outcome).toBe('partially_halted');
  });

  it('no keys (kill before any session): still records the timestamp', async () => {
    const keys = new FakeKeyGateway();
    const { acts, repo } = setup({ keys });
    const result = await acts.revokeKeys({ ...ref, keyIds: [] });
    expect(result.outcome).toBe('revoked');
    expect(keys.calls).toHaveLength(0);
    expect(repo.event.keysRevokedAt).toEqual(T0);
  });

  it('is idempotent: a second run neither calls the gateway nor resets the timestamp', async () => {
    const keys = new FakeKeyGateway();
    const { acts, repo, advance } = setup({ keys });
    await acts.revokeKeys({ ...ref, keyIds: KEYS });
    const first = repo.event.keysRevokedAt;
    advance(5_000);
    expect((await acts.revokeKeys({ ...ref, keyIds: KEYS })).outcome).toBe('skipped');
    expect(keys.calls).toHaveLength(1);
    expect(repo.event.keysRevokedAt).toBe(first);
  });

  it('refuses an event of another tenant', async () => {
    const { acts } = setup();
    await expect(
      acts.revokeKeys({
        tenantId: '0190a000-0000-7000-8000-0000000000ff',
        killEventId: KILL_ID,
        keyIds: KEYS,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('audits keys.revoked with counts only and skips the audit on a re-run', async () => {
    const { acts, audits } = setup();
    const result = await acts.revokeKeys({ ...ref, keyIds: KEYS });
    await acts.auditKeysRevoked({ ...ref, result });
    await acts.auditKeysRevoked({ ...ref, result: { ...result, outcome: 'skipped' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'kill.keys_revoked',
      severity: 'critical',
      outcome: 'success',
      metadata: { total: 2, revoked: 2, failed: 0 },
    });
    expect(JSON.stringify(audits[0])).not.toContain('key-1');
  });
});

describe('cancelWorkflows (stage 4)', () => {
  it('cancels the workflows, flags pending reversals and records workflows_cancelled_at', async () => {
    const workflows = new FakeWorkflowCanceller();
    const reversals = new FakeReversalJournal(3);
    const { acts, repo, metrics } = setup({ workflows, reversals });
    const result = await acts.cancelWorkflows({
      ...ref,
      workflowIds: WFS,
      runIds: [RUN_ID, RUN_ID],
    });
    expect(result.outcome).toBe('cancelled');
    expect(workflows.calls).toEqual([{ workflowIds: WFS }]);
    expect(reversals.calls).toEqual([{ runIds: [RUN_ID] }]);
    expect(result.reversalsFlagged).toBe(3);
    expect(repo.event.workflowsCancelledAt).toEqual(T0);
    expect(repo.event.affected).toMatchObject({ workflows: 2, reversalsFlagged: 3 });
    expect(metrics.workflowCount).toBe(2);
  });

  it('already_closed and not_found count as success', async () => {
    const workflows = new FakeWorkflowCanceller((ids) => [
      { workflowId: ids[0] ?? '', outcome: 'already_closed' },
      { workflowId: ids[1] ?? '', outcome: 'not_found' },
    ]);
    const { acts } = setup({ workflows });
    expect((await acts.cancelWorkflows({ ...ref, workflowIds: WFS, runIds: [] })).outcome).toBe(
      'cancelled',
    );
  });

  it('a workflow that cannot be cancelled marks partially_halted but still stamps the stage', async () => {
    const workflows = new FakeWorkflowCanceller(() => new Error('temporal down'));
    const { acts, repo, metrics } = setup({ workflows, workflowDeadlineMs: 500 });
    const result = await acts.cancelWorkflows({ ...ref, workflowIds: WFS, runIds: [RUN_ID] });
    expect(result.outcome).toBe('partially_halted');
    expect(repo.event.workflowsCancelledAt).not.toBeNull();
    expect(repo.event.status).toBe('partially_halted');
    expect(metrics.partial).toBe(1);
  });

  it('a journal failure throws before the stage is stamped, so the stage is retried', async () => {
    const reversals = new FakeReversalJournal(0, true);
    const { acts, repo } = setup({ reversals });
    await expect(
      acts.cancelWorkflows({ ...ref, workflowIds: WFS, runIds: [RUN_ID] }),
    ).rejects.toThrow('journal down');
    expect(repo.event.workflowsCancelledAt).toBeNull();
  });

  it('is idempotent on a re-run', async () => {
    const workflows = new FakeWorkflowCanceller();
    const { acts } = setup({ workflows });
    await acts.cancelWorkflows({ ...ref, workflowIds: WFS, runIds: [] });
    const again = await acts.cancelWorkflows({ ...ref, workflowIds: WFS, runIds: [] });
    expect(again.outcome).toBe('skipped');
    expect(workflows.calls).toHaveLength(1);
  });

  it('kill before any session started: no workflows, still records the timestamp', async () => {
    const { acts, repo } = setup();
    const result = await acts.cancelWorkflows({ ...ref, workflowIds: [], runIds: [RUN_ID] });
    expect(result.outcome).toBe('cancelled');
    expect(repo.event.workflowsCancelledAt).toEqual(T0);
  });

  it('audits workflows_cancelled with the reversal count', async () => {
    const { acts, audits } = setup({ reversals: new FakeReversalJournal(2) });
    const result = await acts.cancelWorkflows({ ...ref, workflowIds: WFS, runIds: [RUN_ID] });
    await acts.auditWorkflowsCancelled({ ...ref, result });
    expect(audits[0]).toMatchObject({
      action: 'kill.workflows_cancelled',
      outcome: 'success',
      metadata: { total: 2, cancelled: 2, reversalsFlagged: 2 },
    });
  });
});

describe('halt time over all four stages', () => {
  it('finalize completes the event only once every stage recorded, measured from the signal', async () => {
    const { acts, repo, advance } = setup();
    await acts.blockEgress({ ...ref, identities: [runIdentity(RUN_ID)] });
    advance(300);
    await acts.terminateSandboxes({ ...ref, sandboxIds: ['sbx'] });
    expect((await acts.finalizeKill(ref)).completed).toBe(false);
    advance(200);
    await acts.revokeKeys({ ...ref, keyIds: KEYS });
    advance(100);
    await acts.cancelWorkflows({ ...ref, workflowIds: WFS, runIds: [RUN_ID] });
    expect((await acts.finalizeKill(ref)).completed).toBe(true);
    expect(repo.event.status).toBe('halted');
    expect(repo.haltMs).toBe(600);
    for (const col of [
      'egressBlockedAt',
      'sandboxesTerminatedAt',
      'keysRevokedAt',
      'workflowsCancelledAt',
    ] as const) {
      expect(repo.event[col]).not.toBeNull();
    }
  });
});
