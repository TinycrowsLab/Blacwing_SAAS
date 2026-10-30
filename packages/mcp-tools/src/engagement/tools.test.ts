import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';

import { SUBTASK_LIFECYCLE_STATUSES, TEST_CASE_STATUSES } from '@blackwing/contracts';

import { ToolError } from '../errors.js';
import { createToolMetrics } from '../metrics.js';
import { createEngagementMetrics } from './metrics.js';
import { createEngagementTools } from './tools.js';

import type { BrokerClient } from '../broker-client.js';
import type { ToolDefinition, ToolRuntime } from '../tool.js';

const RUN = '01890a5d-ac96-774b-bcce-b302099a8057';
const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8058';
const TEST_CASE = '01890a5d-ac96-774b-bcce-b302099a8059';

const zeroCounts = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

const DISPATCH = {
  persona: 'auth-logic-specialist',
  subtaskId: SUBTASK,
  testCaseId: TEST_CASE,
  brief: {
    targets: ['https://lab.example.test/login'],
    class: 'passive',
    oracle: { type: 'http_status', params: { status: 200 } },
    negativeControl: { type: 'status_diff', params: {} },
    budget: { maxRequests: 100, maxRps: 5, maxConcurrency: 2, maxBytes: 1_000_000 },
    standardRefs: { wstg: ['WSTG-ATHN-01'], cwe: [], owasp: [] },
  },
};

/** A broker that records every call and answers from a canned table keyed by path. */
function brokerWith(answers: Record<string, unknown>) {
  const calls: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [];
  const broker: BrokerClient & { calls: typeof calls } = {
    calls,
    get: ((path: string) => {
      calls.push({ method: 'GET', path });
      return Promise.resolve(answers[path]);
    }) as BrokerClient['get'],
    post: ((path: string, body: unknown) => {
      calls.push({ method: 'POST', path, body });
      return Promise.resolve(answers[path]);
    }) as BrokerClient['post'],
  };
  return broker;
}

/** The JSON envelope a tool answers with (`{ ok, data }` or `{ ok: false, code }`). */
function envelope(
  result:
    { readonly content: readonly { readonly type: string; readonly text?: unknown }[] } | undefined,
): {
  ok: boolean;
  code?: string;
  data?: unknown;
} {
  const first = result?.content[0];
  const text = first?.type === 'text' && typeof first.text === 'string' ? first.text : '{}';
  return JSON.parse(text) as { ok: boolean; code?: string; data?: unknown };
}

/** The calls a tool made to the domain endpoints; every invocation also posts its own `tool-audit`. */
function domainCalls(broker: { calls: { path: string }[] }) {
  return broker.calls.filter((call) => call.path !== 'tool-audit');
}

function runtime(broker: BrokerClient): ToolRuntime {
  return {
    broker,
    evidence: { store: () => Promise.resolve('ev-1') },
    metrics: createToolMetrics(),
    signal: new AbortController().signal,
    subtaskId: null,
    testCaseId: null,
    roleId: 'orchestrator',
  };
}

function tools(): Record<string, ToolDefinition> {
  const registry = new Registry();
  const defs = createEngagementTools(createEngagementMetrics(registry));
  return Object.fromEntries(defs.map((definition) => [definition.name, definition]));
}

describe('engagement tools (MCP-012)', () => {
  it('exposes the seven tools of the engagement server under their contract names', () => {
    expect(Object.keys(tools()).sort()).toEqual(
      [
        'dispatch_subtask',
        'get_engagement_state',
        'get_subtask_result',
        'list_open_subtasks',
        'mark_test_case_status',
        'request_mentor_review',
        'request_scope_exception',
      ].sort(),
    );
    for (const definition of Object.values(tools())) {
      expect(definition.server).toBe('engagement');
      expect(definition.qualifiedName).toBe(`mcp__engagement__${definition.name}`);
    }
  });

  it('never exposes the native Agent or Task tool, and dispatch is not an in-process agent', () => {
    const names = Object.keys(tools());
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('Task');
    // Whole-word `agent` or `task` only: `subtask` is the engagement vocabulary, not the Task tool.
    expect(names.some((name) => /(^|_)(agent|task)(_|$)/.test(name))).toBe(false);
  });

  it.each([
    ['get_engagement_state', true],
    ['list_open_subtasks', true],
    ['get_subtask_result', true],
    ['dispatch_subtask', false],
    ['mark_test_case_status', false],
    ['request_mentor_review', false],
    ['request_scope_exception', false],
  ] as const)('marks %s readOnly=%s', (name, readOnly) => {
    expect(tools()[name]?.readOnly).toBe(readOnly);
  });

  it('reads the engagement state from the broker and counts the read', async () => {
    const state = {
      runId: RUN,
      phase: 'executing',
      testCases: { ...zeroCounts(TEST_CASE_STATUSES), approved: 2 },
      subtasks: { ...zeroCounts(SUBTASK_LIFECYCLE_STATUSES), dispatched: 1 },
      confirmedFindings: 0,
    };
    const registry = new Registry();
    const defs = createEngagementTools(createEngagementMetrics(registry));
    const tool = defs.find((d) => d.name === 'get_engagement_state');
    const broker = brokerWith({ 'engagement/state': state });
    const result = await tool?.invoke({}, runtime(broker));
    expect(domainCalls(broker)).toEqual([{ method: 'GET', path: 'engagement/state' }]);
    expect(result?.isError).toBe(false);
    expect(envelope(result)).toEqual({
      ok: true,
      data: state,
    });
    expect(await registry.getSingleMetricAsString('mcp_engagement_reads_total')).toContain(
      'tool="get_engagement_state"} 1',
    );
  });

  it('dispatches by posting to the broker, which signals the Run Controller: no local agent run', async () => {
    const accepted = { accepted: true, subtaskId: SUBTASK, status: 'dispatched', created: true };
    const broker = brokerWith({ 'engagement/dispatch': accepted });
    const result = await tools().dispatch_subtask?.invoke(DISPATCH, runtime(broker));
    expect(domainCalls(broker)).toEqual([
      { method: 'POST', path: 'engagement/dispatch', body: DISPATCH },
    ]);
    expect(envelope(result)).toEqual({
      ok: true,
      data: accepted,
    });
  });

  it('returns a refusal as a value the orchestrator can read', async () => {
    const refused = { accepted: false, code: 'CONCURRENCY_LIMIT', message: 'back off' };
    const broker = brokerWith({ 'engagement/dispatch': refused });
    const result = await tools().dispatch_subtask?.invoke(DISPATCH, runtime(broker));
    expect(result?.isError).toBe(false);
    expect(envelope(result).data).toEqual(refused);
  });

  it('rejects an oversized brief before any broker call (TOOL_INVALID_INPUT)', async () => {
    const broker = brokerWith({});
    const huge = {
      ...DISPATCH,
      brief: {
        ...DISPATCH.brief,
        targets: Array.from(
          { length: 100 },
          (_, i) => `https://lab.example.test/${String(i)}/${'a'.repeat(200)}`,
        ),
      },
    };
    const result = await tools().dispatch_subtask?.invoke(huge, runtime(broker));
    expect(result?.isError).toBe(true);
    expect(envelope(result).code).toBe('TOOL_INVALID_INPUT');
    expect(domainCalls(broker)).toHaveLength(0);
  });

  it('rejects an unknown extra field in the dispatch input (strict)', async () => {
    const broker = brokerWith({});
    const result = await tools().dispatch_subtask?.invoke(
      { ...DISPATCH, runId: RUN },
      runtime(broker),
    );
    expect(result?.isError).toBe(true);
    expect(domainCalls(broker)).toHaveLength(0);
  });

  it('reports a pending subtask as success with pending set, not as an error', async () => {
    const pending = { subtaskId: SUBTASK, status: 'running', pending: true, result: null };
    const broker = brokerWith({ [`engagement/subtasks/${SUBTASK}/result`]: pending });
    const result = await tools().get_subtask_result?.invoke(
      { subtaskId: SUBTASK },
      runtime(broker),
    );
    expect(result?.isError).toBe(false);
    expect(domainCalls(broker)[0]?.path).toBe(`engagement/subtasks/${SUBTASK}/result`);
  });

  it.each([
    ['not a uuid', { status: 'executing', reason: 'x', testCaseId: 'nope' }],
    [
      'a status outside the allowed set',
      { testCaseId: TEST_CASE, status: 'approved', reason: 'x' },
    ],
    [
      'a status the orchestrator may not set (removed)',
      { testCaseId: TEST_CASE, status: 'removed', reason: 'x' },
    ],
    ['a missing reason', { testCaseId: TEST_CASE, status: 'executed' }],
    ['an empty reason', { testCaseId: TEST_CASE, status: 'executed', reason: '' }],
  ])('mark_test_case_status rejects %s before any call', async (_name, input) => {
    const broker = brokerWith({});
    const result = await tools().mark_test_case_status?.invoke(input, runtime(broker));
    expect(result?.isError).toBe(true);
    expect(envelope(result).code).toBe('TOOL_INVALID_INPUT');
    expect(domainCalls(broker)).toHaveLength(0);
  });

  it('mark_test_case_status posts an allowed execution status with its reason', async () => {
    const answer = { testCaseId: TEST_CASE, status: 'executed', previousStatus: 'executing' };
    const broker = brokerWith({ 'engagement/test-cases/status': answer });
    const result = await tools().mark_test_case_status?.invoke(
      { testCaseId: TEST_CASE, status: 'executed', reason: 'oracle matched' },
      runtime(broker),
    );
    expect(result?.isError).toBe(false);
    expect(domainCalls(broker)[0]).toEqual({
      method: 'POST',
      path: 'engagement/test-cases/status',
      body: { testCaseId: TEST_CASE, status: 'executed', reason: 'oracle matched' },
    });
  });

  it('a broker refusal of an invalid transition reaches the model as TOOL_INVALID_INPUT', async () => {
    const broker: BrokerClient = {
      get: () => Promise.reject(new Error('unused')),
      post: () =>
        Promise.reject(new ToolError('TOOL_INVALID_INPUT', 'the status change is not allowed')),
    };
    const result = await tools().mark_test_case_status?.invoke(
      { testCaseId: TEST_CASE, status: 'executing', reason: 'x' },
      runtime(broker),
    );
    expect(result?.isError).toBe(true);
    expect(envelope(result).code).toBe('TOOL_INVALID_INPUT');
  });

  it('request_scope_exception posts the target and reason to the broker and never allows the target', async () => {
    const answer = { decisionId: SUBTASK, gate: 2, status: 'pending' };
    const broker = brokerWith({ 'engagement/scope-exceptions': answer });
    const result = await tools().request_scope_exception?.invoke(
      { target: 'https://other.example.test', reason: 'redirect host' },
      runtime(broker),
    );
    expect(result?.isError).toBe(false);
    expect(domainCalls(broker)[0]?.path).toBe('engagement/scope-exceptions');
    expect(envelope(result).data).toEqual(answer);
  });

  it('request_mentor_review posts the subtask and reason', async () => {
    const answer = { reviewId: TEST_CASE, status: 'requested' };
    const broker = brokerWith({ 'engagement/mentor-reviews': answer });
    const result = await tools().request_mentor_review?.invoke(
      { subtaskId: SUBTASK, reason: 'stalled' },
      runtime(broker),
    );
    expect(result?.isError).toBe(false);
    expect(domainCalls(broker)[0]?.path).toBe('engagement/mentor-reviews');
  });

  it('a backend fault during a dispatch is a failure, never an accepted subtask', async () => {
    const broker: BrokerClient = {
      get: () => Promise.reject(new Error('unused')),
      post: vi.fn(() => Promise.reject(new ToolError('TOOL_BACKEND_UNAVAILABLE', 'down'))),
    };
    const result = await tools().dispatch_subtask?.invoke(DISPATCH, runtime(broker));
    expect(result?.isError).toBe(true);
    expect(envelope(result).code).toBe('TOOL_BACKEND_UNAVAILABLE');
  });
});
