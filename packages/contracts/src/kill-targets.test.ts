// Kill target set contract (KILL-002): what the kill scope resolver hands the propagation coordinator.

import { describe, expect, it } from 'vitest';

import {
  KILL_PROXY_PRINCIPAL_PATTERN,
  killEgressIdentitySchema,
  killTargetSetSchema,
} from './index.js';

const ID = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe('killTargetSetSchema (KILL-002)', () => {
  const set = {
    runIds: [ID(10)],
    sessionIds: ['s1'],
    sandboxIds: ['sbx-1'],
    virtualKeyIds: ['vk-1'],
    egressIdentities: [
      { kind: 'run', runId: ID(10) },
      { kind: 'proxy_principal', runId: ID(10), sessionId: 's1', principal: 'tc_abc.role_r1' },
    ],
    workflowIds: ['wf-1'],
  };

  it('round-trips a target set and the empty set', () => {
    expect(killTargetSetSchema.parse(set)).toEqual(set);
    const empty = {
      runIds: [],
      sessionIds: [],
      sandboxIds: [],
      virtualKeyIds: [],
      egressIdentities: [],
      workflowIds: [],
    };
    expect(killTargetSetSchema.parse(empty)).toEqual(empty);
  });

  it('rejects malformed ids, principals and extra keys', () => {
    expect(killTargetSetSchema.safeParse({ ...set, runIds: ['run-1'] }).success).toBe(false);
    expect(killTargetSetSchema.safeParse({ ...set, sessionIds: [''] }).success).toBe(false);
    expect(killTargetSetSchema.safeParse({ ...set, extra: 1 }).success).toBe(false);
    expect(
      killEgressIdentitySchema.safeParse({
        kind: 'proxy_principal',
        runId: ID(10),
        sessionId: 's1',
        principal: 'tc_abc.role_r1:token@egress',
      }).success,
    ).toBe(false);
    expect(KILL_PROXY_PRINCIPAL_PATTERN.test('tc_abc.role_r1')).toBe(true);
  });
});
