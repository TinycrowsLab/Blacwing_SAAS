// ORCH-002 (#226): signals, queries, optimistic concurrency and failure handling of AssessmentRunWorkflow.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RUN_SIGNALS, type RunSummary } from '@blackwing/contracts';

import {
  createRunHarness,
  type RunHandle,
  type RunHarness,
  RunStubs,
  USER_APPROVER,
  USER_REQUESTER,
  startRun,
  waitForState,
} from '../run/testing.js';

let harness: RunHarness;
beforeAll(async () => {
  harness = await createRunHarness();
}, 120_000);
afterAll(async () => {
  await harness.teardown();
});

const SYSTEM = { kind: 'system', id: 'timer' } as const;
const FINDING = '0190a000-0000-7000-8000-0000000000f1';

function start(): Promise<RunHandle> {
  return startRun(harness);
}

const summary = (h: { query<T>(n: string): Promise<T> }) => h.query<RunSummary>('getSummary');

describe('AssessmentRunWorkflow signals', () => {
  it('ignores a duplicate gate 1 decision and an out-of-order resume without crashing', async () => {
    const stubs = new RunStubs();
    const exec = stubs.hold('runExecution');
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.resume, { actor: USER_APPROVER }); // illegal here
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_APPROVER, decision: 'approved' });
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_APPROVER, decision: 'approved' }); // duplicate
      await exec.reached;
      const s = await summary(h);
      expect(s.state).toBe('executing');
      expect(s.ignoredSignals).toBe(2);
      exec.release();
      await waitForState(h, 'awaiting_gate3');
      await h.signal(RUN_SIGNALS.kill, { actor: USER_APPROVER, scope: 'run' });
      await h.result();
    });
    expect(stubs.persisted.filter((p) => p.to === 'approved')).toHaveLength(1);
  });

  it('refuses invalid payloads and approval by the requester (separation of duties)', async () => {
    const stubs = new RunStubs();
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.gate1Decision, { decision: 'approved' }); // no actor
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_APPROVER, decision: 'maybe' });
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_REQUESTER, decision: 'approved' });
      // A system actor cannot approve unless the run is inside the standing authorisation.
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: SYSTEM, decision: 'approved' });
      const s = await summary(h);
      expect(s.state).toBe('awaiting_gate1');
      expect(s.ignoredSignals).toBe(4);
      await h.signal(RUN_SIGNALS.kill, { actor: USER_APPROVER, scope: 'run' });
      await h.result();
    });
  });

  it('auto-approves gate 1 only for a system actor with autoApproved', async () => {
    const stubs = new RunStubs();
    const exec = stubs.hold('runExecution');
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.gate1Decision, {
        actor: SYSTEM,
        decision: 'approved',
        autoApproved: true,
      });
      await exec.reached;
      await h.signal(RUN_SIGNALS.kill, { actor: SYSTEM, scope: 'run' });
      await h.result();
    });
    expect(stubs.audits.find((a) => a.intent.event === 'run.gate1_approved')?.actor.kind).toBe(
      'system',
    );
  });

  it('rejects gate 1 into cancelled', async () => {
    const stubs = new RunStubs();
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_APPROVER, decision: 'rejected' });
      expect((await h.result()).state).toBe('cancelled');
    });
  });

  it('pauses, resumes (with the envelope re-checked) and releases a gate 2 pause', async () => {
    const stubs = new RunStubs();
    const exec = stubs.hold('runExecution');
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_APPROVER, decision: 'approved' });
      await exec.reached;
      await h.signal(RUN_SIGNALS.pause, { actor: USER_APPROVER, reason: 'gate2_pending' });
      const paused = await waitForState(h, 'paused');
      expect(paused.pauseReason).toBe('gate2_pending');
      expect(await h.query('getPhase')).toBe('executing');
      await h.signal(RUN_SIGNALS.pause, { actor: USER_APPROVER, reason: 'gate2_pending' }); // idempotent
      // A denial leaves it paused; an approval by a person resumes it.
      await h.signal(RUN_SIGNALS.gate2Decision, {
        actor: USER_APPROVER,
        subtaskId: 't1',
        decision: 'denied',
      });
      await h.signal(RUN_SIGNALS.gate2Decision, {
        actor: USER_APPROVER,
        subtaskId: 't2',
        decision: 'approved',
      });
      await waitForState(h, 'executing');
      exec.release(); // the held call and its re-run both finish
      await waitForState(h, 'awaiting_gate3');
      await h.signal(RUN_SIGNALS.gate3Released, { actor: USER_APPROVER, findingIds: [FINDING] });
      expect((await h.result()).state).toBe('completed');
    });
    expect(stubs.phaseCalls.filter((c) => c === 'runExecution')).toHaveLength(2);
  });

  it('refuses to resume without a valid envelope and refuses to start execution without one', async () => {
    const stubs = new RunStubs();
    const exec = stubs.hold('runExecution');
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_APPROVER, decision: 'approved' });
      await exec.reached;
      await h.signal(RUN_SIGNALS.pause, { actor: USER_APPROVER, reason: 'operator_pause' });
      await waitForState(h, 'paused');
      stubs.envelopeValid = false;
      await h.signal(RUN_SIGNALS.resume, { actor: USER_APPROVER });
      const s = await summary(h);
      expect(s.state).toBe('paused');
      await h.signal(RUN_SIGNALS.kill, { actor: USER_APPROVER, scope: 'run' });
      await h.result();
    });

    const noEnvelope = new RunStubs();
    noEnvelope.envelopeValid = false;
    await harness.withWorker(noEnvelope, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.gate1Decision, { actor: USER_APPROVER, decision: 'approved' });
      const result = await h.result();
      expect(result.state).toBe('failed');
    });
    expect(noEnvelope.phaseCalls).not.toContain('runExecution');
  });

  it("applies sa_expired and window_closed with the machine's targets and drops signals after the end", async () => {
    const expired = new RunStubs();
    const rec = expired.hold('runRecon');
    await harness.withWorker(expired, async () => {
      const h = await start();
      await rec.reached;
      await h.signal(RUN_SIGNALS.saExpired, { actor: SYSTEM });
      expect((await h.result()).state).toBe('expired');
    });
    const closed = new RunStubs();
    const rec2 = closed.hold('runRecon');
    await harness.withWorker(closed, async () => {
      const h = await start();
      await rec2.reached;
      await h.signal(RUN_SIGNALS.windowClosed, { actor: SYSTEM });
      expect((await h.result()).state).toBe('failed');
    });
  });

  it('increases the budget for a person only, within the ceilings', async () => {
    const stubs = new RunStubs();
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.increaseBudget, {
        actor: USER_APPROVER,
        delta: { costCapUsd: 25 },
      });
      await h.signal(RUN_SIGNALS.increaseBudget, { actor: SYSTEM, delta: { costCapUsd: 25 } });
      await h.signal(RUN_SIGNALS.increaseBudget, {
        actor: USER_APPROVER,
        delta: { costCapUsd: 1e12 },
      });
      await h.signal(RUN_SIGNALS.increaseBudget, {
        actor: USER_APPROVER,
        delta: { maxRequests: -5 },
      });
      const remaining = await h.query<{ costCapUsd: number }>('getBudgetRemaining');
      expect(remaining.costCapUsd).toBe(75);
      expect((await summary(h)).ignoredSignals).toBe(3);
      expect(await h.query('getOpenSubtasks')).toEqual([]);
      await h.signal(RUN_SIGNALS.kill, { actor: USER_APPROVER, scope: 'run' });
      await h.result();
    });
  });

  it('retries a state_version conflict, re-reads and applies the event once', async () => {
    const stubs = new RunStubs();
    stubs.conflictsToInject = 2;
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await waitForState(h, 'awaiting_gate1');
      await h.signal(RUN_SIGNALS.kill, { actor: USER_APPROVER, scope: 'run' });
      expect((await h.result()).state).toBe('killed');
    });
    // Every state appears once: no duplicate transitions despite the lost races.
    expect(new Set(stubs.path).size).toBe(stubs.path.length);
    expect(stubs.audits.filter((a) => a.intent.event === 'run.kill')).toHaveLength(1);
  });

  it('stops when the externally moved state is terminal', async () => {
    const stubs = new RunStubs();
    const gate = stubs.hold('runRecon');
    await harness.withWorker(stubs, async () => {
      const h = await start();
      await gate.reached;
      // The API cancels the run behind the workflow's back.
      stubs.row = { state: 'cancelled', version: stubs.row.version + 1, pauseReason: null };
      gate.release();
      expect((await h.result()).state).toBe('cancelled');
    });
    expect(stubs.audits.map((a) => a.intent.event)).not.toContain('run.recon_complete');
  });

  it('fails the run with a reason when a phase reports failure or an activity outage exhausts retries', async () => {
    const failed = new RunStubs();
    failed.phaseResults.set('runPreflight', { outcome: 'failed', reason: 'target unreachable' });
    await harness.withWorker(failed, async () => {
      const h = await start();
      const result = await h.result();
      expect(result.state).toBe('failed');
    });
    const failAudit = failed.audits.find((a) => a.intent.event === 'run.fail');
    expect(failAudit?.detail).toBe('target unreachable');
    expect(failAudit?.actor).toEqual({ kind: 'system', id: 'system' });

    const outage = new RunStubs();
    outage.phaseThrows.add('runPreflight');
    await harness.withWorker(outage, async () => {
      const h = await start();
      expect((await h.result()).state).toBe('failed');
      expect((await summary(h)).failureReason).toContain('runPreflight');
    });
    // Idempotent preflight was retried 3 times; the non-idempotent recon is never retried.
    expect(outage.phaseCalls.filter((c) => c === 'runPreflight')).toHaveLength(3);

    const once = new RunStubs();
    once.phaseThrows.add('runRecon');
    await harness.withWorker(once, async () => {
      const h = await start();
      expect((await h.result()).state).toBe('failed');
    });
    expect(once.phaseCalls.filter((c) => c === 'runRecon')).toHaveLength(1);
  });
});
