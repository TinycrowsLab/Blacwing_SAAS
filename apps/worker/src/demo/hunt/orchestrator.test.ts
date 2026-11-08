import { describe, expect, it } from 'vitest';

import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { caseOutcome, coverageOf, settle, toolGate } from './orchestrator.js';

import type { HuntRun } from './types.js';

const run: HuntRun = {
  id: 'run-1',
  tenantId: 't',
  requestId: 'r',
  assetId: 'a',
  assetName: 'Asset',
  objective: 'test',
  scope: { allowedOrigins: ['https://t.example'], excludedPaths: [] },
  budgetRequests: 10,
  budgetSeconds: 60,
  costCapUsd: 1,
  intrusiveness: 'active_safe',
  testAccounts: [
    { role: 'alice', headerName: 'Authorization', headerValue: 'Bearer a' },
    { role: 'bob', headerName: 'Authorization', headerValue: 'Bearer b' },
  ],
  releaseProven: 'hold',
  labOrigins: [],
};

function context(sleep: (ms: number) => Promise<void> = () => Promise.resolve(), abort = new AbortController()): HuntContext {
  const store = new FakeStore();
  return {
    run,
    store,
    log: new EventLog(store, run.id, { warn: () => undefined, error: () => undefined }),
    signal: abort.signal,
    deps: { fetch, sleep, now: () => 0, gate2TimeoutMs: 1000, webhookUrl: null, consoleOrigin: 'http://console.test' },
    state: newHuntState(),
  };
}

describe('settle', () => {
  it('maps how a run ended to its terminal state', () => {
    expect(settle(null, null, { subtype: 'success', summary: 's' })).toEqual({ state: 'completed', reason: null });
    expect(settle(null, null, { subtype: 'error_max_budget_usd', summary: null })).toEqual({ state: 'completed', reason: 'cost_cap' });
    expect(settle(null, null, { subtype: 'error_max_turns', summary: null })).toEqual({ state: 'completed', reason: 'max_turns' });
    expect(settle('duration_budget', 'AbortError', null)).toEqual({ state: 'completed', reason: 'duration_budget' });
    expect(settle(null, 'Error', null)).toEqual({ state: 'failed', reason: 'Error' });
    expect(settle(null, null, null)).toEqual({ state: 'failed', reason: 'no_result' });
    expect(settle(null, null, { subtype: 'error_during_execution', summary: null })).toEqual({ state: 'failed', reason: 'error_during_execution' });
  });
});

describe('coverage', () => {
  const base = { title: 't', agent: 'web-api-specialist', note: null, requests: 0, candidates: 0 };

  it('derives case status from what was sent, keeping a model skip or block', () => {
    expect(caseOutcome({ ...base, status: 'executed' })).toBe('not_run');
    expect(caseOutcome({ ...base, status: 'executing', requests: 2 })).toBe('executed');
    expect(caseOutcome({ ...base, status: 'proposed', candidates: 1 })).toBe('executed');
    expect(caseOutcome({ ...base, status: 'skipped', requests: 3 })).toBe('skipped');
    expect(caseOutcome({ ...base, status: 'blocked' })).toBe('blocked');
  });

  it('reports cases, roles configured and used, requests sent and the end reason', () => {
    const ctx = context();
    ctx.state.cases.set('sqli', { ...base, title: 'SQLi in search', status: 'executing', requests: 4 });
    ctx.state.cases.set('idor', { ...base, agent: 'authz-specialist', status: 'skipped', note: 'one object only' });
    ctx.state.roleCounts.set('alice', 3);
    ctx.state.requestsUsed = 10;
    expect(coverageOf(ctx, 'request_budget')).toEqual({
      cases: [
        { id: 'sqli', title: 'SQLi in search', agent: 'web-api-specialist', status: 'executed', note: null, requests: 4, candidates: 0 },
        { id: 'idor', title: 't', agent: 'authz-specialist', status: 'skipped', note: 'one object only', requests: 0, candidates: 0 },
      ],
      rolesConfigured: ['alice', 'bob'],
      rolesUsed: { alice: 3 },
      requestsSent: 10,
      endReason: 'request_budget',
    });
  });

  it('marks a case blocked when the only request it needed was denied at Gate 2', () => {
    const ctx = context();
    ctx.state.cases.set('email', { ...base, status: 'executing' });
    ctx.state.asks.set('g1', { id: 'g1', key: 'k', label: 'PUT /users/v1/name2/email as reader1', agent: 'authz-specialist', caseId: 'email', deadlineAt: 0, status: 'denied' });
    expect(coverageOf(ctx, null).cases).toEqual([
      { id: 'email', title: 't', agent: 'web-api-specialist', status: 'blocked', note: 'Gate 2 denied: PUT /users/v1/name2/email as reader1', requests: 0, candidates: 0 },
    ]);
  });

  it('never calls an ask the run closed at its end a denial: nobody answered it', () => {
    const ctx = context();
    ctx.state.cases.set('email', { ...base, status: 'executing' });
    ctx.state.asks.set('g1', { id: 'g1', key: 'k', label: 'PUT /x as reader1', agent: 'authz-specialist', caseId: 'email', deadlineAt: 0, status: 'denied', closedUnanswered: true });
    expect(coverageOf(ctx, null).cases).toMatchObject([{ status: 'blocked', note: 'Gate 2 got no answer before the audit ended: PUT /x as reader1' }]);
  });
});

describe('toolGate (PreToolUse)', () => {
  const signal = new AbortController().signal;
  const call = (ctx: HuntContext, toolName: string) =>
    toolGate(ctx).hooks[0]?.({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { url: 'x', agent: 'forged' }, agent_type: 'recon', tool_use_id: 'u', session_id: 's', transcript_path: '', cwd: '' } as never, 'u', { signal });

  it('stamps the calling agent into Blackwing tools only', async () => {
    const ctx = context();
    expect(await call(ctx, 'mcp__blackwing__http_request')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { url: 'x', agent: 'recon' } } });
    expect(await call(ctx, 'Agent')).toEqual({});
  });

  it('holds every tool call, delegations included, while the run is paused', async () => {
    let sleeps = 0;
    const ctx = context(() => {
      sleeps += 1;
      if (sleeps === 3) ctx.state.paused = false;
      return Promise.resolve();
    });
    ctx.state.paused = true;
    expect(await call(ctx, 'Agent')).toEqual({});
    expect(sleeps).toBe(3);
  });

  it('lets go once the run is killed', async () => {
    const abort = new AbortController();
    const ctx = context(() => {
      abort.abort();
      return Promise.resolve();
    }, abort);
    ctx.state.paused = true;
    expect(await call(ctx, 'mcp__blackwing__submit_candidate')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  });
});
