// ORCH-002 (#226): `kill` in any phase drives the run to `killed` and completes the workflow, first in line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RUN_SIGNALS, type RunState } from '@blackwing/contracts';

import {
  createRunHarness,
  type PhaseName,
  type RunHandle,
  type RunHarness,
  RunStubs,
  USER_APPROVER,
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

const KILL = { actor: { kind: 'user', id: 'owner-1' }, scope: 'run', reason: 'stop now' } as const;

function start(): Promise<RunHandle> {
  return startRun(harness);
}

/** States that block on a phase activity: kill must cancel it. */
const PHASES: readonly [RunState, PhaseName][] = [
  ['preflight', 'runPreflight'],
  ['recon', 'runRecon'],
  ['planning', 'runPlanning'],
  ['executing', 'runExecution'],
  ['validating', 'runValidation'],
  ['reporting', 'runReporting'],
];

describe('AssessmentRunWorkflow kill', () => {
  it.each(PHASES)('kills a run in %s, cancelling the in-flight phase', async (state, phase) => {
    const stubs = new RunStubs();
    const hold = stubs.hold(phase); // never released: kill must not wait for the phase
    await harness.withWorker(stubs, async () => {
      const handle = await start();
      // Walk to the phase under test.
      if (['executing', 'validating', 'reporting'].includes(state)) {
        await waitForState(handle, 'awaiting_gate1');
        await handle.signal(RUN_SIGNALS.gate1Decision, {
          actor: USER_APPROVER,
          decision: 'approved',
        });
      }
      if (['reporting'].includes(state)) {
        await waitForState(handle, 'awaiting_gate3');
        await handle.signal(RUN_SIGNALS.gate3Released, {
          actor: USER_APPROVER,
          findingIds: ['0190a000-0000-7000-8000-0000000000f1'],
        });
      }
      await hold.reached;
      await handle.signal(RUN_SIGNALS.kill, KILL);
      const result = await handle.result();
      expect(result.state).toBe('killed');
    });
    expect(stubs.row.state).toBe('killed');
    expect(stubs.audits.at(-1)?.intent.event).toBe('run.kill');
    expect(stubs.audits.at(-1)?.actor).toEqual(KILL.actor);
    hold.release();
  });

  it.each(['awaiting_gate1', 'awaiting_gate3'] as const)(
    'kills a run waiting at %s',
    async (state) => {
      const stubs = new RunStubs();
      await harness.withWorker(stubs, async () => {
        const handle = await start();
        await waitForState(handle, 'awaiting_gate1');
        if (state === 'awaiting_gate3') {
          await handle.signal(RUN_SIGNALS.gate1Decision, {
            actor: USER_APPROVER,
            decision: 'approved',
          });
          await waitForState(handle, 'awaiting_gate3');
        }
        await handle.signal(RUN_SIGNALS.kill, KILL);
        expect((await handle.result()).state).toBe('killed');
      });
    },
  );

  it('kills a paused run and a run held at approved or released', async () => {
    // paused
    const stubs = new RunStubs();
    const exec = stubs.hold('runExecution');
    await harness.withWorker(stubs, async () => {
      const handle = await start();
      await waitForState(handle, 'awaiting_gate1');
      await handle.signal(RUN_SIGNALS.gate1Decision, {
        actor: USER_APPROVER,
        decision: 'approved',
      });
      await exec.reached;
      await handle.signal(RUN_SIGNALS.pause, { actor: USER_APPROVER, reason: 'operator_pause' });
      await waitForState(handle, 'paused');
      await handle.signal(RUN_SIGNALS.kill, KILL);
      expect((await handle.result()).state).toBe('killed');
    });

    // approved: the envelope check is still running when the kill lands, the kill goes first
    const s2 = new RunStubs();
    const env = s2.hold('verifyEnvelope');
    await harness.withWorker(s2, async () => {
      const handle = await start();
      await waitForState(handle, 'awaiting_gate1');
      await handle.signal(RUN_SIGNALS.gate1Decision, {
        actor: USER_APPROVER,
        decision: 'approved',
      });
      await env.reached;
      await handle.signal(RUN_SIGNALS.kill, KILL);
      env.release();
      const result = await handle.result();
      expect(result.state).toBe('killed');
    });
    expect(s2.path).not.toContain('executing');

    // released: held in the gate3_released audit write
    const s3 = new RunStubs();
    const audit = s3.hold('audit:run.gate3_released');
    await harness.withWorker(s3, async () => {
      const handle = await start();
      await waitForState(handle, 'awaiting_gate1');
      await handle.signal(RUN_SIGNALS.gate1Decision, {
        actor: USER_APPROVER,
        decision: 'approved',
      });
      await waitForState(handle, 'awaiting_gate3');
      await handle.signal(RUN_SIGNALS.gate3Released, {
        actor: USER_APPROVER,
        findingIds: ['0190a000-0000-7000-8000-0000000000f1'],
      });
      await audit.reached;
      await handle.signal(RUN_SIGNALS.kill, KILL);
      audit.release();
      expect((await handle.result()).state).toBe('killed');
    });
    expect(s3.path).not.toContain('reporting');
  });

  it('a duplicate kill is a no-op and a kill after the end is dropped', async () => {
    const stubs = new RunStubs();
    await harness.withWorker(stubs, async () => {
      const handle = await start();
      await waitForState(handle, 'awaiting_gate1');
      await handle.signal(RUN_SIGNALS.kill, KILL);
      await handle.signal(RUN_SIGNALS.kill, KILL);
      expect((await handle.result()).state).toBe('killed');
    });
    expect(stubs.audits.filter((a) => a.intent.event === 'run.kill')).toHaveLength(1);
  });
});
