import type { LifecycleEnv } from './lifecycle.js';
import type {
  AgentSessionActivities,
  AgentSessionInput,
  RunSessionResult,
  SessionAuditEvent,
} from './types.js';

const SHA256_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export const INPUT: AgentSessionInput = {
  tenantId: 'tnt_1',
  runId: 'run_1',
  subtaskId: 'sub_1',
  persona: 'web-api-specialist',
  personaVersion: '1.2.0',
  brief: 'test the login endpoint',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  maxTurns: 20,
  maxBudgetUsd: 5,
  intrusiveness: 'safe',
  egressIdentity: 'run:run_1',
};

export const RUN_OK: RunSessionResult = {
  result: {
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    session_id: 'sess_abc',
    num_turns: 7,
    total_cost_usd: 0.42,
    modelUsage: {
      'claude-sonnet-5-5': {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 10,
        costUSD: 0.42,
      },
    },
  },
  pins: { promptSha256: SHA256_HEX, sdkVersion: '1.0.0', claudeCodeVersion: '2.0.0' },
  transcriptKey: 'transcripts/tnt_1/run_1/sess_abc.jsonl',
};

export class CancelledFailure extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledFailure';
  }
}

/** Records every activity call in order. Overrides replace individual activities. */
export function fakeActivities(overrides: Partial<AgentSessionActivities> = {}): {
  acts: AgentSessionActivities;
  calls: string[];
  audits: SessionAuditEvent[];
  requests: Record<string, unknown[]>;
} {
  const calls: string[] = [];
  const audits: SessionAuditEvent[] = [];
  const requests: Record<string, unknown[]> = {};
  const track =
    <A, R>(name: string, impl: (arg: A) => Promise<R>) =>
    async (arg: A): Promise<R> => {
      calls.push(name);
      (requests[name] ??= []).push(arg);
      return impl(arg);
    };
  const acts: AgentSessionActivities = {
    provisionSandbox: track('provisionSandbox', () =>
      Promise.resolve({ sandboxId: 'sbx_1', workspaceDir: '/workspace', caRef: 'openbao://ca/1' }),
    ),
    issueVirtualKey: track('issueVirtualKey', () =>
      Promise.resolve({ keyId: 'vk_1', keyRef: 'ref://vk_1' }),
    ),
    recordSessionStart: track('recordSessionStart', () => Promise.resolve()),
    runAgentSession: track('runAgentSession', () => Promise.resolve(RUN_OK)),
    recordSessionFinish: track('recordSessionFinish', () => Promise.resolve()),
    recordSessionCost: track('recordSessionCost', () => Promise.resolve()),
    recordDeclinedCoverage: track('recordDeclinedCoverage', () => Promise.resolve()),
    emitSessionAudit: track('emitSessionAudit', (event: SessionAuditEvent) => {
      audits.push(event);
      return Promise.resolve();
    }),
    flushEvidence: track('flushEvidence', () => Promise.resolve()),
    revokeVirtualKey: track('revokeVirtualKey', () => Promise.resolve()),
    destroySandbox: track('destroySandbox', () => Promise.resolve()),
    reportTeardownFailure: track('reportTeardownFailure', () => Promise.resolve()),
  };
  for (const [name, impl] of Object.entries(overrides)) {
    (acts as unknown as Record<string, unknown>)[name] = track(
      name,
      impl as (arg: never) => Promise<unknown>,
    );
  }
  return { acts, calls, audits, requests };
}

export const ENV: LifecycleEnv = {
  nonCancellable: (fn) => fn(),
  isCancellation: (error) => error instanceof CancelledFailure,
};
