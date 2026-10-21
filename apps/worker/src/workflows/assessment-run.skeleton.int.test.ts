// ORCH-002 (#226) integration: AssessmentRunWorkflow end to end on a local Temporal test server with stub
// activities. Needs no Docker; the first run downloads the Temporal dev-server binary.
import { writeFileSync } from 'node:fs';

import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RUN_SIGNALS, runWorkflowId, type RunState, type RunSummary } from '@blackwing/contracts';

import {
  APPROVER,
  createRunHarness,
  encodeHistory,
  FINDING,
  type RunHarness,
  RunStubs,
  runInput,
  startRun,
  TENANT,
  USER_APPROVER,
  waitForState,
  REPLAY_HISTORY_PATH,
} from '../run/testing.js';

let harness: RunHarness;
beforeAll(async () => {
  harness = await createRunHarness();
}, 120_000);
afterAll(async () => {
  await harness.teardown();
});

const HAPPY_PATH: RunState[] = [
  'draft',
  'preflight',
  'recon',
  'planning',
  'awaiting_gate1',
  'approved',
  'executing',
  'validating',
  'awaiting_gate3',
  'released',
  'reporting',
  'completed',
];

describe('AssessmentRunWorkflow skeleton', () => {
  it('runs draft to completed, answers getState at every phase and audits each transition', async () => {
    const stubs = new RunStubs();
    const input = runInput();
    const holds = {
      preflight: stubs.hold('runPreflight'),
      recon: stubs.hold('runRecon'),
      planning: stubs.hold('runPlanning'),
      executing: stubs.hold('runExecution'),
      validating: stubs.hold('runValidation'),
      reporting: stubs.hold('runReporting'),
    };
    await harness.withWorker(stubs, async () => {
      const handle = await startRun(harness, input);
      expect(handle.workflowId).toBe(runWorkflowId(input.runId));

      for (const phase of ['preflight', 'recon', 'planning'] as const) {
        await holds[phase].reached;
        expect((await handle.query<{ state: string }>('getState')).state).toBe(phase);
        expect(await handle.query('getPhase')).toBe(phase);
        holds[phase].release();
      }
      const gate1 = await waitForState(handle, 'awaiting_gate1');
      expect(gate1.version).toBe(4);
      await handle.signal(RUN_SIGNALS.gate1Decision, {
        actor: USER_APPROVER,
        decision: 'approved',
      });

      await holds.executing.reached;
      expect((await handle.query<{ state: string }>('getState')).state).toBe('executing');
      holds.executing.release();
      await holds.validating.reached;
      expect((await handle.query<{ state: string }>('getState')).state).toBe('validating');
      holds.validating.release();

      await waitForState(handle, 'awaiting_gate3');
      await handle.signal(RUN_SIGNALS.gate3Released, {
        actor: USER_APPROVER,
        findingIds: [FINDING],
      });
      await holds.reporting.reached;
      expect((await handle.query<{ state: string }>('getState')).state).toBe('reporting');
      const summary = await handle.query<RunSummary>('getSummary');
      expect(summary.releasedFindingIds).toEqual([FINDING]);
      holds.reporting.release();

      const result = await handle.result();
      expect(result).toEqual({ state: 'completed', version: 11, pauseReason: null });
      // Regenerates the committed replay fixture: BW_UPDATE_REPLAY_HISTORY=1 pnpm --filter @blackwing/worker test:int
      if (process.env.BW_UPDATE_REPLAY_HISTORY === '1') {
        writeFileSync(REPLAY_HISTORY_PATH, encodeHistory(await handle.fetchHistory()));
      }
    });

    expect(stubs.path).toEqual(HAPPY_PATH);
    expect(stubs.audits.map((a) => a.intent.event)).toEqual([
      'run.preflight_started',
      'run.preflight_passed',
      'run.recon_complete',
      'run.plan_proposed',
      'run.gate1_approved',
      'run.execution_started',
      'run.validation_started',
      'run.gate3_requested',
      'run.gate3_released',
      'run.reporting_started',
      'run.completed',
    ]);
    // Human signals are audited under the sender, controller steps under `system`.
    const byEvent = new Map(stubs.audits.map((a) => [a.intent.event, a.actor]));
    expect(byEvent.get('run.gate1_approved')).toEqual({ kind: 'user', id: APPROVER });
    expect(byEvent.get('run.recon_complete')).toEqual({ kind: 'system', id: 'system' });
    // The tenant is threaded into every activity (§7).
    expect([...stubs.tenants]).toEqual([TENANT]);
  });

  it('lists per tenant by the TenantId search attribute and stamps the run state', async () => {
    const stubs = new RunStubs();
    const input = runInput();
    const hold = stubs.hold('runExecution');
    await harness.withWorker(stubs, async () => {
      const handle = await startRun(harness, input);
      await waitForState(handle, 'awaiting_gate1');
      await handle.signal(RUN_SIGNALS.gate1Decision, {
        actor: USER_APPROVER,
        decision: 'approved',
      });
      await hold.reached;
      const desc = await handle.describe();
      const attr = (name: string) =>
        desc.typedSearchAttributes.get(defineSearchAttributeKey(name, SearchAttributeType.KEYWORD));
      expect(attr('tenantId')).toBe(TENANT);
      expect(attr('runState')).toBe('executing');
      await handle.signal(RUN_SIGNALS.kill, {
        actor: { kind: 'system', id: 'kill-coordinator' },
        scope: 'run',
      });
      await handle.result();
    });
  });
});
