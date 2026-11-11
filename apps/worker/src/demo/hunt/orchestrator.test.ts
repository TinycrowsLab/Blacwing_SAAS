import { describe, expect, it } from 'vitest';

import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { caseOutcome, coverageOf, holdForAsks, nextRound, settle, toolGate } from './orchestrator.js';

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
    expect(caseOutcome({ ...base, status: 'model_declined', requests: 1 })).toBe('model_declined');
  });

  it('reports cases, roles configured and used, requests sent and the end reason', () => {
    const ctx = context();
    ctx.state.cases.set('sqli', { ...base, title: 'SQLi in search', status: 'executing', requests: 4 });
    ctx.state.cases.set('idor', { ...base, agent: 'authz-specialist', status: 'skipped', note: 'one object only' });
    ctx.state.roleCounts.set('alice', 3);
    ctx.state.requestsUsed = 10;
    expect(coverageOf(ctx, 'request_budget')).toEqual({
      loginWall: false,
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

describe('runner-owned rounds', () => {
  const base = { title: 'SQLi in search', agent: 'web-api-specialist', target: '/search', note: null, requests: 0, candidates: 0, status: 'proposed' };
  const at = { round: 1, spentUsd: 0.1, elapsedS: 10 };
  const big = { ...run, budgetRequests: 1000, budgetSeconds: 900, costCapUsd: 8 };
  const withRun = (r: HuntRun): HuntContext => ({ ...context(), run: r });

  it('hands untried cases and approved-but-unsent asks back to the team', () => {
    const ctx = withRun(big);
    ctx.state.requestsUsed = 400;
    ctx.state.cases.set('sqli', { ...base });
    ctx.state.cases.set('xss', { ...base, title: 'XSS', requests: 3 });
    ctx.state.asks.set('g1', { id: 'g1', key: 'k', label: 'POST /login as no test account', agent: 'web-api-specialist', caseId: 'sqli', deadlineAt: 0, status: 'approved' });
    const next = nextRound(ctx, at);
    expect(next?.cases).toEqual(['sqli']);
    expect(next?.prompt).toContain('- sqli (web-api-specialist): SQLi in search at /search');
    expect(next?.prompt).toContain('POST /login as no test account (case sqli): approved by a person');
    expect(next?.prompt).not.toContain('record_test_cases');
  });

  it('widens a narrow first round, then ends when nothing is untried', () => {
    const ctx = withRun(big);
    ctx.state.requestsUsed = 40;
    ctx.state.cases.set('xss', { ...base, requests: 3 });
    expect(nextRound(ctx, at)?.prompt).toContain('record_test_cases');
    expect(nextRound(ctx, { ...at, round: 2 })).toBeNull();
  });

  it('asks for another round when inputs were found and a class has no case, once per class, and never behind a login wall', () => {
    const ctx = withRun(big);
    ctx.state.requestsUsed = 400;
    ctx.state.inputsSeen = 3;
    ctx.state.cases.set('sqli', { ...base, requests: 2, title: 'SQL injection in search' });
    const next = nextRound(ctx, { ...at, round: 2 });
    expect(next?.widen).toBe(true);
    expect(next?.prompt).toContain('No test case covers: reflected XSS, stored XSS, OS command injection, file inclusion and path traversal, file upload, CSRF');
    expect(nextRound(ctx, { ...at, round: 3 })).toBeNull();
    const walled = withRun(big);
    walled.state.requestsUsed = 400;
    walled.state.inputsSeen = 3;
    walled.state.loginWall = true;
    expect(nextRound(walled, { ...at, round: 2 })).toBeNull();
  });

  it('never starts a round without budget or past the round cap', () => {
    const ctx = withRun(big);
    ctx.state.cases.set('sqli', { ...base });
    expect(nextRound(ctx, { ...at, round: 4 })).toBeNull();
    expect(nextRound(ctx, { ...at, spentUsd: 7.5 })).toBeNull();
    expect(nextRound(ctx, { ...at, elapsedS: 870 })).toBeNull();
    ctx.state.requestsUsed = 950;
    expect(nextRound(ctx, at)).toBeNull();
  });

  it('holds the run open until a pending ask is decided, and stops holding when halted', async () => {
    let sleeps = 0;
    const ctx = context(() => {
      sleeps += 1;
      const entry = (ctx.store as FakeStore).gate2.get('g1');
      if (sleeps === 2 && entry !== undefined) entry.status = 'approved';
      return Promise.resolve();
    });
    const row = { id: 'g1', agent: 'authz-specialist', method: 'POST', url: 'https://t.example/x', pathKey: 'k', reason: 'r', whyOutside: 'w', deadlineAt: new Date(8.64e15), body: null, asRole: null };
    await ctx.store.insertGate2(run, row);
    ctx.state.asks.set('g1', { id: 'g1', key: 'k', label: 'POST /x as alice', agent: 'authz-specialist', caseId: null, deadlineAt: Number.MAX_SAFE_INTEGER, status: 'pending' });
    await holdForAsks(ctx, () => false);
    expect(sleeps).toBe(2);
    expect(ctx.state.asks.get('g1')?.status).toBe('approved');
    const stuck = context();
    stuck.state.asks.set('g2', { id: 'g2', key: 'k', label: 'POST /y', agent: 'a', caseId: null, deadlineAt: Number.MAX_SAFE_INTEGER, status: 'pending' });
    await holdForAsks(stuck, () => true);
    expect(stuck.state.asks.get('g2')?.status).toBe('pending');
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
