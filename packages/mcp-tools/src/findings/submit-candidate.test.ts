import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { createCandidateMetrics } from './metrics.js';
import {
  createSubmitCandidateTool,
  type DeclaredTestCase,
  type SubmitCandidateSession,
} from './submit-candidate.js';
import { createToolMetrics } from '../metrics.js';

import type { BrokerClient } from '../broker-client.js';
import type { ToolRuntime } from '../tool.js';

const TEST_CASE = '01890a5d-ac96-774b-bcce-b302099a8059';
const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8058';
const EVIDENCE = '01890a5d-ac96-774b-bcce-b302099a8070';
const FINDING = '01890a5d-ac96-774b-bcce-b302099a8071';
const oracle = { type: 'response.status', params: { expected: 403 } };

const declared = (over: Partial<DeclaredTestCase> = {}): DeclaredTestCase => ({
  id: TEST_CASE,
  class: 'active_safe',
  status: 'executing',
  oracle,
  negativeControl: { type: 'response.status', params: { expected: 200 } },
  ...over,
});

function setup(
  testCase: DeclaredTestCase = declared(),
  extra: Partial<SubmitCandidateSession> = {},
  post?: BrokerClient['post'],
) {
  const registry = new Registry();
  const posted: { suffix: string; body: Record<string, unknown> }[] = [];
  const broker: BrokerClient = {
    get: () => Promise.reject(new Error('unused')),
    post: (post ??
      ((suffix: string, body: unknown) => {
        posted.push({ suffix, body: body as Record<string, unknown> });
        return Promise.resolve(
          suffix === 'candidates' ? { findingId: FINDING, status: 'candidate' } : undefined,
        );
      })) as BrokerClient['post'],
  };
  const runtime: ToolRuntime = {
    broker,
    evidence: { store: () => Promise.resolve('ev-1') },
    metrics: createToolMetrics(registry),
    signal: new AbortController().signal,
    subtaskId: SUBTASK,
    testCaseId: TEST_CASE,
    roleId: 'web-api-specialist',
  };
  const tool = createSubmitCandidateTool({
    testCase,
    evidenceExists: () => Promise.resolve(true),
    hasReversalEntry: () => Promise.resolve(true),
    metrics: createCandidateMetrics(registry),
    ...extra,
  });
  const call = async (input: unknown) => {
    const result = await tool.invoke(input, runtime);
    return JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}') as Record<
      string,
      unknown
    >;
  };
  return { call, posted, registry };
}

const valid = {
  testCaseId: TEST_CASE,
  class: 'idor',
  cweId: 'CWE-639',
  owaspCategory: 'A01:2021',
  location: {
    method: 'GET',
    urlTemplate: '/api/orders/{id}',
    parameter: 'id',
    file: null,
    line: null,
  },
  oracleBinding: { params: { expected: 403 }, type: 'response.status' },
  negativeControlRef: 'response.status',
  evidenceRefs: [EVIDENCE],
  confidence: 0.7,
  summary: 'Order of another user readable (CWE-639).',
};

describe('submit_candidate', () => {
  it('is mcp__findings__submit_candidate and not read-only', () => {
    const tool = createSubmitCandidateTool({
      testCase: declared(),
      evidenceExists: () => Promise.resolve(true),
      hasReversalEntry: () => Promise.resolve(true),
      metrics: createCandidateMetrics(new Registry()),
    });
    expect(tool.qualifiedName).toBe('mcp__findings__submit_candidate');
    expect(tool.readOnly).toBe(false);
  });

  it('creates a candidate bound to the oracle, evidence and test case', async () => {
    const { call, posted, registry } = setup();
    expect(await call(valid)).toEqual({
      ok: true,
      data: { findingId: FINDING, status: 'candidate' },
    });
    const body = posted.find((p) => p.suffix === 'candidates')?.body;
    expect(body).toMatchObject({
      testCaseId: TEST_CASE,
      evidenceIds: [EVIDENCE],
      oracleBinding: oracle,
      negativeControlRef: 'response.status',
      vulnClass: 'idor',
    });
    expect(body).not.toHaveProperty('status');
    expect(await registry.metrics()).toContain('mcp_candidates_submitted_total{class="idor"} 1');
  });

  it('rejects a post-hoc oracle', async () => {
    const { call, posted, registry } = setup();
    const result = await call({
      ...valid,
      oracleBinding: { type: 'response.status', params: { expected: 500 } },
    });
    expect(result).toMatchObject({ ok: false, code: 'TOOL_INVALID_INPUT' });
    expect(result.message).toContain('oracle_not_predeclared');
    expect(posted.some((p) => p.suffix === 'candidates')).toBe(false);
    expect(await registry.metrics()).toContain(
      'mcp_candidate_rejections_total{reason="oracle_not_predeclared"} 1',
    );
  });

  it('rejects a submission without a declared negative control', async () => {
    const { call } = setup(declared({ negativeControl: null }));
    expect((await call(valid)).message).toContain('missing_negative_control');
  });

  it('rejects a negative control reference that is not the declared one', async () => {
    const { call } = setup();
    expect((await call({ ...valid, negativeControlRef: 'other' })).message).toContain(
      'missing_negative_control',
    );
  });

  it('rejects another test case, a test case not running and destructive ones', async () => {
    const { call } = setup();
    expect((await call({ ...valid, testCaseId: FINDING })).message).toContain('wrong_test_case');
    const proposed = setup(declared({ status: 'proposed' }));
    expect((await proposed.call(valid)).message).toContain('test_case_not_running');
    const destructive = setup(declared({ class: 'destructive' }));
    expect((await destructive.call(valid)).message).toContain('test_case_not_running');
  });

  it('rejects state_changing without a reversal-journal entry', async () => {
    const without = setup(declared({ class: 'state_changing' }), {
      hasReversalEntry: () => Promise.resolve(false),
    });
    expect((await without.call(valid)).message).toContain('missing_reversal_journal');
    const withEntry = setup(declared({ class: 'state_changing' }));
    expect(await withEntry.call(valid)).toMatchObject({ ok: true });
  });

  it('rejects missing, malformed and unknown evidence refs', async () => {
    const { call } = setup(declared(), { evidenceExists: () => Promise.resolve(false) });
    expect((await call(valid)).message).toContain('invalid_evidence');
    const plain = setup();
    expect(await plain.call({ ...valid, evidenceRefs: [] })).toMatchObject({
      ok: false,
      code: 'TOOL_INVALID_INPUT',
    });
    expect(await plain.call({ ...valid, evidenceRefs: ['nope'] })).toMatchObject({
      ok: false,
      code: 'TOOL_INVALID_INPUT',
    });
  });

  it('is idempotent per (test case, location, oracle binding)', async () => {
    const { call, posted } = setup();
    const first = await call(valid);
    const second = await call({ ...valid, summary: 'again', confidence: 0.9 });
    expect(second).toEqual(first);
    expect(posted.filter((p) => p.suffix === 'candidates')).toHaveLength(1);
    await call({ ...valid, location: { ...valid.location, parameter: 'other' } });
    expect(posted.filter((p) => p.suffix === 'candidates')).toHaveLength(2);
  });

  it('cannot set a status: the input refuses it and the result is always candidate', async () => {
    const { call, posted } = setup();
    expect(await call({ ...valid, status: 'confirmed' })).toMatchObject({
      ok: false,
      code: 'TOOL_INVALID_INPUT',
    });
    expect(posted.some((p) => p.suffix === 'candidates')).toBe(false);
    const lying = setup(declared(), {}, (() =>
      Promise.resolve({ findingId: FINDING, status: 'confirmed' })) as BrokerClient['post']);
    expect(await lying.call(valid)).toMatchObject({ ok: false });
  });

  it('truncates an oversized summary', async () => {
    const { call, posted } = setup();
    await call({ ...valid, summary: 'x'.repeat(50_000) });
    const summary = posted.find((p) => p.suffix === 'candidates')?.body.summary as string;
    expect(summary.length).toBe(2000);
  });

  it('reports an unreachable backend and stays retryable', async () => {
    let up = false;
    const { call } = setup(declared(), {}, ((suffix: string) =>
      suffix === 'tool-audit'
        ? Promise.resolve(undefined)
        : up
          ? Promise.resolve({ findingId: FINDING, status: 'candidate' })
          : Promise.reject(new (class extends Error {})('down'))) as BrokerClient['post']);
    expect(await call(valid)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
    up = true;
    expect(await call(valid)).toMatchObject({ ok: true });
  });
});
