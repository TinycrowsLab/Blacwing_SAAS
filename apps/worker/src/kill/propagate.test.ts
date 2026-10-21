import { describe, expect, it } from 'vitest';

import { isEmptyTargetSet, runKillPropagation } from './propagate.js';
import { KILL_ID, makeRequest, RUN_ID, runIdentity, TENANT } from './testing.js';

import type { KillActivities, KillLaterStage, KillProgress } from './types.js';

const fresh = (): { current: KillProgress } => ({
  current: { received: true, stage: 'waiting', egress: null, completed: false },
});

function recorder(overrides: Partial<KillActivities> = {}) {
  const calls: string[] = [];
  const acts: KillActivities = {
    blockEgress: () => {
      calls.push('egress');
      return Promise.resolve({ outcome: 'blocked', identities: [], attempts: 1, latencyMs: 3 });
    },
    auditEgressBlocked: () => {
      calls.push('audit');
      return Promise.resolve();
    },
    completeEmptyKill: () => {
      calls.push('empty');
      return Promise.resolve();
    },
    finalizeKill: () => {
      calls.push('finalize');
      return Promise.resolve({ completed: false });
    },
    ...overrides,
  };
  const stage = (name: KillLaterStage['name'], fail = false): KillLaterStage => ({
    name,
    run: () => {
      calls.push(name);
      return fail ? Promise.reject(new Error('boom')) : Promise.resolve();
    },
  });
  return { calls, acts, stage };
}

describe('runKillPropagation', () => {
  const request = makeRequest([runIdentity(RUN_ID)]);

  it('runs egress first, then later stages strictly in order, then finalizes', async () => {
    const { calls, acts, stage } = recorder();
    await runKillPropagation(
      request,
      acts,
      [stage('sandbox'), stage('keys'), stage('workflows')],
      fresh(),
    );
    expect(calls).toEqual(['egress', 'audit', 'sandbox', 'keys', 'workflows', 'finalize']);
  });

  it('an empty target set completes immediately without touching the gateway', async () => {
    const { calls, acts } = recorder();
    const progress = fresh();
    await runKillPropagation(makeRequest([]), acts, [], progress);
    expect(calls).toEqual(['empty']);
    expect(progress.current).toMatchObject({ stage: 'done', completed: true });
    expect(isEmptyTargetSet(makeRequest([]))).toBe(true);
    expect(isEmptyTargetSet(request)).toBe(false);
  });

  it('an egress activity failure does not stop the kill (fail closed, proceed)', async () => {
    const { calls, acts, stage } = recorder({
      blockEgress: () => Promise.reject(new Error('db down')),
    });
    const progress = fresh();
    await runKillPropagation(request, acts, [stage('sandbox')], progress);
    expect(calls).toEqual(['sandbox', 'finalize']);
    expect(progress.current.egress).toBe('partially_halted');
  });

  it('an audit failure does not stop the kill', async () => {
    const { calls, acts, stage } = recorder({
      auditEgressBlocked: () => Promise.reject(new Error('ledger down')),
    });
    await runKillPropagation(request, acts, [stage('sandbox')], fresh());
    expect(calls).toEqual(['egress', 'sandbox', 'finalize']);
  });

  it('a failing later stage does not skip the stages after it', async () => {
    const { calls, acts, stage } = recorder();
    await runKillPropagation(request, acts, [stage('sandbox', true), stage('keys')], fresh());
    expect(calls).toEqual(['egress', 'audit', 'sandbox', 'keys', 'finalize']);
  });

  it('reports progress for the reconciler query', async () => {
    const { acts } = recorder();
    const progress = fresh();
    await runKillPropagation(request, acts, [], progress);
    expect(progress.current).toEqual({
      received: true,
      stage: 'done',
      egress: 'blocked',
      completed: false,
    });
    expect(request.killEventId).toBe(KILL_ID);
    expect(request.tenantId).toBe(TENANT);
  });
});
