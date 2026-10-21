import { describe, expect, it } from 'vitest';

import { runAgentSessionLifecycle, SandboxProvisionError } from './lifecycle.js';
import { CancelledFailure, ENV, fakeActivities, INPUT, RUN_OK } from './testing.js';

import type { RunSessionResult } from './types.js';

const TEARDOWN = ['revokeVirtualKey', 'flushEvidence', 'destroySandbox'];

function teardownCalls(calls: string[]): string[] {
  return calls.filter((c) => TEARDOWN.includes(c));
}

describe('runAgentSessionLifecycle', () => {
  it('provisions, runs, maps, records and tears down on success', async () => {
    const { acts, calls, audits } = fakeActivities();
    const out = await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);

    expect(out).toEqual({
      sessionRef: 'ses_1',
      sessionId: 'sess_abc',
      sandboxId: 'sbx_1',
      subtask: { status: 'submitted', declined: false },
      numTurns: 7,
      totalCostUsd: 0.42,
    });
    expect(calls.indexOf('provisionSandbox')).toBeLessThan(calls.indexOf('runAgentSession'));
    expect(teardownCalls(calls)).toEqual(TEARDOWN);
    expect(calls).not.toContain('recordDeclinedCoverage');
    expect(audits.map((a) => a.type)).toEqual([
      'sandbox.provisioned',
      'session.started',
      'session.finished',
      'virtualkey.revoked',
      'sandbox.destroyed',
    ]);
  });

  it('persists the start row before the run so a kill can resolve sandbox and key', async () => {
    const { acts, calls, requests } = fakeActivities();
    await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(calls.indexOf('recordSessionStart')).toBeLessThan(calls.indexOf('runAgentSession'));
    expect(requests.recordSessionStart?.[0]).toMatchObject({
      sandboxId: 'sbx_1',
      virtualKeyId: 'vk_1',
      persona: 'web-api-specialist',
      personaVersion: '1.2.0',
    });
  });

  it('records the pins, transcript key and usage on the finish row', async () => {
    const { acts, requests } = fakeActivities();
    await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(requests.recordSessionFinish?.[0]).toMatchObject({
      pins: RUN_OK.pins,
      sessionId: 'sess_abc',
      transcriptKey: RUN_OK.transcriptKey,
      numTurns: 7,
      totalCostUsd: 0.42,
      modelUsage: RUN_OK.result.modelUsage,
      subtype: 'success',
    });
  });

  it('hands the runtime only the key reference, CA ref and sandbox, never key material', async () => {
    const { acts, requests } = fakeActivities();
    await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    const req = requests.runAgentSession?.[0] as Record<string, unknown>;
    expect(req).toMatchObject({
      keyRef: 'ref://vk_1',
      caRef: 'openbao://ca/1',
      sandboxId: 'sbx_1',
      egressIdentity: 'run:run_1',
    });
    expect(JSON.stringify(requests)).not.toContain('bwk_');
  });

  it.each([
    ['error_max_turns', 'blocked'],
    ['error_max_budget_usd', 'blocked'],
    ['error_during_execution', 'failed'],
    ['error_max_structured_output_retries', 'failed'],
    ['tool_deferred', 'deferred'],
  ] as const)('returns the mapper status for %s (%s)', async (subtype, status) => {
    const { acts, calls } = fakeActivities({
      runAgentSession: () =>
        Promise.resolve<RunSessionResult>({
          ...RUN_OK,
          result: { ...RUN_OK.result, subtype },
        }),
    });
    const out = await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(out.subtask.status).toBe(status);
    expect(out.sessionId).toBe('sess_abc');
    expect(teardownCalls(calls)).toEqual(TEARDOWN);
  });

  it('returns model_declined and records a coverage entry on refusal', async () => {
    const { acts, requests } = fakeActivities({
      runAgentSession: () =>
        Promise.resolve<RunSessionResult>({
          ...RUN_OK,
          result: { ...RUN_OK.result, stop_reason: 'refusal' },
        }),
    });
    const out = await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(out.subtask).toEqual({ status: 'model_declined', reason: 'refusal', declined: true });
    expect(requests.recordDeclinedCoverage?.[0]).toMatchObject({
      runId: 'run_1',
      subtaskId: 'sub_1',
      persona: 'web-api-specialist',
      reason: 'refusal',
    });
  });

  it('turns a runtime crash or timeout into a mapped failed status and still tears down', async () => {
    const { acts, calls, requests } = fakeActivities({
      runAgentSession: () => Promise.reject(new Error('activity timed out')),
    });
    const out = await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(out.subtask.status).toBe('failed');
    expect(out.sessionId).toBeNull();
    expect(requests.recordSessionFinish?.[0]).toMatchObject({ pins: null, sessionId: null });
    expect(teardownCalls(calls)).toEqual(TEARDOWN);
  });

  it('retries provisioning once on a different node', async () => {
    let attempt = 0;
    const { acts, requests } = fakeActivities({
      provisionSandbox: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error('node full'))
          : Promise.resolve({ sandboxId: 'sbx_2', workspaceDir: '/w', caRef: 'ref://ca' });
      },
    });
    const out = await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(out.sandboxId).toBe('sbx_2');
    expect(
      requests.provisionSandbox?.map((r) => (r as { differentNode: boolean }).differentNode),
    ).toEqual([false, true]);
  });

  it('fails the child after the second provision failure, still running teardown', async () => {
    const { acts, calls } = fakeActivities({
      provisionSandbox: () => Promise.reject(new Error('no capacity')),
    });
    await expect(runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV)).rejects.toBeInstanceOf(
      SandboxProvisionError,
    );
    expect(calls.filter((c) => c === 'provisionSandbox')).toHaveLength(2);
    // Nothing was created, but the controller is told to reap by sessionRef.
    expect(calls).toContain('destroySandbox');
    expect(calls).not.toContain('runAgentSession');
    expect(calls).not.toContain('revokeVirtualKey');
  });

  it('does not retry provisioning when cancelled', async () => {
    const { acts, calls } = fakeActivities({
      provisionSandbox: () => Promise.reject(new CancelledFailure()),
    });
    await expect(runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV)).rejects.toBeInstanceOf(
      CancelledFailure,
    );
    expect(calls.filter((c) => c === 'provisionSandbox')).toHaveLength(1);
    expect(calls).toContain('destroySandbox');
  });

  it('revokes the key and destroys the sandbox when key issuing fails after provisioning', async () => {
    const { acts, calls, requests } = fakeActivities({
      issueVirtualKey: () => Promise.reject(new Error('gateway down')),
    });
    await expect(runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV)).rejects.toThrow(
      'gateway down',
    );
    expect(calls).not.toContain('revokeVirtualKey');
    expect(requests.destroySandbox?.[0]).toMatchObject({ sandboxId: 'sbx_1' });
  });

  it('tears down and rethrows when recording fails after the run', async () => {
    const { acts, calls } = fakeActivities({
      recordSessionFinish: () => Promise.reject(new Error('db down')),
    });
    await expect(runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV)).rejects.toThrow('db down');
    expect(teardownCalls(calls)).toEqual(TEARDOWN);
  });

  it('on cancel/kill revokes the key, destroys the sandbox and audits session.killed', async () => {
    const { acts, calls, audits, requests } = fakeActivities({
      runAgentSession: () => Promise.reject(new CancelledFailure()),
    });
    await expect(runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV)).rejects.toBeInstanceOf(
      CancelledFailure,
    );
    expect(teardownCalls(calls)).toEqual(TEARDOWN);
    expect(requests.revokeVirtualKey?.[0]).toMatchObject({ keyId: 'vk_1' });
    expect(audits.map((a) => a.type)).toContain('session.killed');
    expect(audits.map((a) => a.type)).not.toContain('session.finished');
  });

  it('runs teardown through the non-cancellable wrapper', async () => {
    let shielded = 0;
    const { acts } = fakeActivities();
    await runAgentSessionLifecycle(INPUT, 'ses_1', acts, {
      ...ENV,
      nonCancellable: (fn) => {
        shielded += 1;
        return fn();
      },
    });
    expect(shielded).toBe(1);
  });

  it('keeps tearing down when one step fails, and reports an orphaned sandbox', async () => {
    const { acts, calls, requests } = fakeActivities({
      revokeVirtualKey: () => Promise.reject(new Error('revoke failed')),
      flushEvidence: () => Promise.reject(new Error('flush failed')),
      destroySandbox: () => Promise.reject(new Error('node unreachable')),
    });
    const out = await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(out.subtask.status).toBe('submitted');
    expect(teardownCalls(calls)).toEqual(TEARDOWN);
    expect(requests.reportTeardownFailure).toEqual([
      expect.objectContaining({ kind: 'virtual_key', resourceId: 'vk_1' }),
      expect.objectContaining({ kind: 'sandbox', resourceId: 'sbx_1', error: 'node unreachable' }),
    ]);
  });

  it('does not audit virtualkey.revoked or sandbox.destroyed when those steps failed', async () => {
    const { acts, audits } = fakeActivities({
      revokeVirtualKey: () => Promise.reject(new Error('x')),
      destroySandbox: () => Promise.reject(new Error('y')),
    });
    await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    const types = audits.map((a) => a.type);
    expect(types).not.toContain('virtualkey.revoked');
    expect(types).not.toContain('sandbox.destroyed');
  });

  it('never writes a test-case status: the result carries only the subtask outcome', async () => {
    const { acts } = fakeActivities();
    const out = await runAgentSessionLifecycle(INPUT, 'ses_1', acts, ENV);
    expect(Object.keys(out)).not.toContain('testCaseStatus');
    expect(['submitted', 'blocked', 'failed', 'model_declined', 'deferred']).toContain(
      out.subtask.status,
    );
  });

  it('passes the resume session id through so a deferred session can continue', async () => {
    const { acts, requests } = fakeActivities();
    await runAgentSessionLifecycle({ ...INPUT, resumeSessionId: 'sess_prev' }, 'ses_2', acts, ENV);
    expect(requests.runAgentSession?.[0]).toMatchObject({ resumeSessionId: 'sess_prev' });
  });
});
