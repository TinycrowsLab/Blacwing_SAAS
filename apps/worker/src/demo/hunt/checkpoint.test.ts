import { describe, expect, it } from 'vitest';

import { buildEvidence, checkpointLine, decideLoop, MAX_ROUNDS, parseCheckpoint, unvisitedPages } from './checkpoint.js';
import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';

import type { HuntRun } from './types.js';

const run: HuntRun = {
  id: 'run-1',
  tenantId: 't',
  requestId: 'r',
  assetId: 'a',
  assetName: 'Asset',
  objective: 'test',
  scope: { allowedOrigins: ['https://t.example'], excludedPaths: [] },
  budgetRequests: 100,
  budgetSeconds: 600,
  costCapUsd: 5,
  intrusiveness: 'active_safe',
  testAccounts: [{ role: 'admin', headerName: 'Cookie', headerValue: 'x' }],
  releaseProven: 'hold',
  labOrigins: [],
};

function context(): HuntContext {
  const store = new FakeStore();
  return { run, store, log: new EventLog(store, run.id, { warn: () => undefined, error: () => undefined }), signal: new AbortController().signal, deps: { fetch, sleep: () => Promise.resolve(), now: () => 0, gate2TimeoutMs: 1, webhookUrl: null, consoleOrigin: 'http://c' }, state: newHuntState() };
}

const done = { complete: true, reasons: ['all pages tried'], untested: [], next_focus: [] };
const open = { complete: false, reasons: ['csp page untested'], untested: ['/csp/'], next_focus: ['CSP'] };
const idle = { round: 2, limit: null, untried: 0, approvedUnsent: 0, newUnvisited: 0 };

describe('decideLoop', () => {
  it('finishes complete only when the checkpoint says so and nothing recorded is pending', () => {
    expect(decideLoop({ ...idle, checkpoint: done })).toEqual({ kind: 'complete' });
    expect(decideLoop({ ...idle, checkpoint: done, limit: 'cost_cap' })).toEqual({ kind: 'complete' });
  });

  it('does not accept a complete verdict while a case, an approved ask or a discovered page is pending', () => {
    expect(decideLoop({ ...idle, checkpoint: done, untried: 1 })).toEqual({ kind: 'continue' });
    expect(decideLoop({ ...idle, checkpoint: done, approvedUnsent: 1 })).toEqual({ kind: 'continue' });
    expect(decideLoop({ ...idle, checkpoint: done, newUnvisited: 2 })).toEqual({ kind: 'continue' });
  });

  it('continues when not complete and budget is left', () => {
    expect(decideLoop({ ...idle, checkpoint: open })).toEqual({ kind: 'continue' });
  });

  it('stops at the limit that is hit, naming it, and at the safety round cap', () => {
    expect(decideLoop({ ...idle, checkpoint: open, limit: 'request_budget' })).toEqual({ kind: 'stop', reason: 'request_budget' });
    expect(decideLoop({ ...idle, checkpoint: open, limit: 'duration_budget' })).toEqual({ kind: 'stop', reason: 'duration_budget' });
    expect(decideLoop({ ...idle, checkpoint: open, round: MAX_ROUNDS })).toEqual({ kind: 'stop', reason: 'round_cap' });
    expect(MAX_ROUNDS).toBeGreaterThanOrEqual(12);
  });
});

describe('checkpoint text', () => {
  it('words the visible event', () => {
    expect(checkpointLine(2, done, { kind: 'complete' })).toBe('Completion check (round 2): complete - all pages tried');
    expect(checkpointLine(1, open, { kind: 'continue' })).toBe('Completion check (round 1): not complete - csp page untested; continuing');
    expect(checkpointLine(3, open, { kind: 'stop', reason: 'cost_cap' })).toContain('not complete - csp page untested; stopping at the limit');
  });

  it('parses the critic answer from surrounding text and rejects junk', () => {
    expect(parseCheckpoint('Here: {"complete": false, "reasons": ["a"], "untested": ["x"], "next_focus": ["y"]} done')).toEqual({ complete: false, reasons: ['a'], untested: ['x'], next_focus: ['y'] });
    expect(parseCheckpoint('{"complete": "maybe"}')).toBeNull();
    expect(parseCheckpoint('no json')).toBeNull();
  });

  it('lists discovered pages that were never requested, in the evidence', () => {
    const ctx = context();
    ctx.state.linked.add('/a/');
    ctx.state.linked.add('/b/');
    ctx.state.visited.add('/a/');
    expect(unvisitedPages(ctx)).toEqual(['/b/']);
    expect(buildEvidence(ctx, { round: 1 })).toContain('- /b/');
  });
});
