import { describe, expect, it, vi } from 'vitest';

import { createUuidV7Generator } from '@blackwing/ids';

import {
  createEngagementPort,
  createRunControllerDispatch,
  createScopeExceptionRequest,
  type EngagementRef,
  markTestCaseStatus,
  type RunControllerClient,
  type ScopeExceptionStore,
  type TestCaseStatusStore,
} from './engagement.js';

import type { TestCaseStatus } from '@blackwing/contracts';

const gen = createUuidV7Generator();
const REF: EngagementRef = { tenantId: gen(), runId: gen() };
const TEST_CASE = gen();
const SUBTASK = gen();
const NOW = new Date('2026-10-30T10:00:00.000Z');

/** A test-case store that holds one status and compares-and-sets it like the Postgres adapter. */
function caseStore(status: TestCaseStatus = 'approved') {
  const state: { status: TestCaseStatus } = { status };
  const store = {
    state,
    currentStatus: (_ref: EngagementRef, id: string) =>
      Promise.resolve(id === TEST_CASE ? state.status : null),
    compareAndSet: (_ref: EngagementRef, id: string, from: TestCaseStatus, to: TestCaseStatus) => {
      if (id !== TEST_CASE || state.status !== from) return Promise.resolve(false);
      state.status = to;
      return Promise.resolve(true);
    },
  } satisfies TestCaseStatusStore & { state: typeof state };
  return store;
}

describe('markTestCaseStatus (MCP-012: only valid enum transitions)', () => {
  it.each([
    ['approved', 'executing'],
    ['approved', 'skipped'],
    ['approved', 'blocked'],
    ['approved', 'not_applicable'],
    ['executing', 'executed'],
    ['executing', 'failed'],
    ['executing', 'model_declined'],
    ['blocked', 'executing'],
  ] as const)('moves %s to %s and reports the previous status', async (from, to) => {
    const store = caseStore(from);
    const result = await markTestCaseStatus(store, REF, {
      testCaseId: TEST_CASE,
      status: to,
      reason: 'ran',
    });
    expect(result).toEqual({ testCaseId: TEST_CASE, status: to, previousStatus: from });
    expect(store.state.status).toBe(to);
  });

  it.each([
    ['approved', 'executed'],
    ['proposed', 'executing'],
    ['executed', 'executing'],
    ['failed', 'executed'],
    ['blocked', 'executed'],
  ] as const)('refuses %s to %s with INVALID_TRANSITION and writes nothing', async (from, to) => {
    const store = caseStore(from);
    const compareAndSet = vi.spyOn(store, 'compareAndSet');
    await expect(
      markTestCaseStatus(store, REF, { testCaseId: TEST_CASE, status: to, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(compareAndSet).not.toHaveBeenCalled();
    expect(store.state.status).toBe(from);
  });

  it('answers NOT_FOUND for a test case of this run that does not exist', async () => {
    await expect(
      markTestCaseStatus(caseStore(), REF, { testCaseId: gen(), status: 'executing', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a racing change: the compare-and-set loses and the status is not overwritten', async () => {
    const store = caseStore('approved');
    store.compareAndSet = () => Promise.resolve(false);
    await expect(
      markTestCaseStatus(store, REF, { testCaseId: TEST_CASE, status: 'executing', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('createRunControllerDispatch (ORCH-007: signals the Run Controller)', () => {
  const input = {
    persona: 'auth-logic-specialist',
    subtaskId: SUBTASK,
    testCaseId: TEST_CASE,
    brief: {
      targets: ['https://lab.example.test/login'],
      class: 'passive',
      oracle: { type: 'status_code', expected: 200 },
      negativeControl: { type: 'status_code', expected: 404 },
      budget: { requests: 10 },
      standardRefs: { wstg: ['WSTG-ATHN-01'], cwe: [], owasp: [] },
    },
  } as never;

  it('sends the dispatchSubtask update to the run execution workflow and never runs a specialist itself', async () => {
    const executeUpdate = vi.fn<RunControllerClient['executeUpdate']>(() =>
      Promise.resolve({
        accepted: true,
        subtaskId: SUBTASK,
        status: 'dispatched',
        created: true,
        session: null,
      }),
    );
    const dispatch = createRunControllerDispatch({ executeUpdate });
    const outcome = await dispatch(REF, input);
    expect(executeUpdate).toHaveBeenCalledTimes(1);
    expect(executeUpdate).toHaveBeenCalledWith(`execution-${REF.runId}`, 'dispatchSubtask', [
      input,
    ]);
    expect(outcome).toEqual({
      accepted: true,
      subtaskId: SUBTASK,
      status: 'dispatched',
      created: true,
    });
  });

  it('passes a refusal through as a value, with its code', async () => {
    const dispatch = createRunControllerDispatch({
      executeUpdate: () =>
        Promise.resolve({ accepted: false, code: 'PERSONA_INELIGIBLE', message: 'no mandate' }),
    });
    await expect(dispatch(REF, input)).resolves.toEqual({
      accepted: false,
      code: 'PERSONA_INELIGIBLE',
      message: 'no mandate',
    });
  });

  it('rejects an answer that is not a dispatch outcome, so nothing is reported as accepted', async () => {
    const dispatch = createRunControllerDispatch({
      executeUpdate: () => Promise.resolve({ accepted: true }),
    });
    await expect(dispatch(REF, input)).rejects.toThrow();
  });
});

describe('createScopeExceptionRequest (GATE2: a scope exception opens a Gate 2 decision)', () => {
  it('opens one pending scope_exception row with the target, a 30 minute timeout and a target-keyed dedupe key', async () => {
    const open = vi.fn<ScopeExceptionStore['open']>((_tenant, input) =>
      Promise.resolve({ row: { decisionId: input.decisionId, status: 'pending' }, created: true }),
    );
    const request = createScopeExceptionRequest(
      { open },
      { gate2TimeoutMinutes: 30, newId: () => SUBTASK, now: () => NOW },
    );
    const result = await request(REF, {
      target: 'https://other.example.test',
      reason: 'redirect host',
    });
    expect(result).toEqual({ decisionId: SUBTASK, gate: 2, status: 'pending' });
    const [tenant, row] = open.mock.calls[0] ?? [];
    expect(tenant).toBe(REF.tenantId);
    expect(row).toMatchObject({
      runId: REF.runId,
      kind: 'scope_exception',
      target: 'https://other.example.test',
      summary: 'https://other.example.test: redirect host',
      requestedAt: NOW,
      timeoutAt: new Date('2026-10-30T10:30:00.000Z'),
      subtaskId: null,
      sessionId: null,
      toolUseId: null,
    });
    expect(row?.dedupeKey).toMatch(/^scope:target:[0-9a-f]{64}$/);
  });

  it('keys a repeat request for the same target to the same dedupe key', async () => {
    const keys: string[] = [];
    const open: ScopeExceptionStore['open'] = (_tenant, input) => {
      keys.push(input.dedupeKey);
      return Promise.resolve({ row: { decisionId: gen(), status: 'pending' }, created: false });
    };
    const request = createScopeExceptionRequest(
      { open },
      { gate2TimeoutMinutes: 30, newId: gen, now: () => NOW },
    );
    await request(REF, { target: 'https://a.example.test', reason: 'one' });
    await request(REF, { target: 'https://a.example.test', reason: 'two' });
    expect(keys[0]).toBe(keys[1]);
  });
});

describe('createEngagementPort (fails closed without an adapter)', () => {
  const port = createEngagementPort({ gate2TimeoutMinutes: 30, newId: gen, now: () => NOW });

  it.each([
    ['state', () => port.state(REF)],
    ['open subtasks', () => port.openSubtasks(REF)],
    ['dispatch', () => port.dispatch(REF, {} as never)],
    ['subtask result', () => port.subtaskResult(REF, SUBTASK)],
    [
      'test case status',
      () => port.markTestCase(REF, { testCaseId: TEST_CASE, status: 'executing', reason: 'x' }),
    ],
    [
      'mentor review',
      () => port.requestMentorReview(REF, { subtaskId: SUBTASK, reason: 'stalled' }),
    ],
    [
      'scope exception',
      () => port.requestScopeException(REF, { target: 'https://a.example.test', reason: 'x' }),
    ],
  ])('answers NOT_IMPLEMENTED for %s when its adapter is not wired', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('wires the test-case status adapter when given one', async () => {
    const wired = createEngagementPort({
      testCases: caseStore('approved'),
      gate2TimeoutMinutes: 30,
      newId: gen,
      now: () => NOW,
    });
    await expect(
      wired.markTestCase(REF, { testCaseId: TEST_CASE, status: 'executing', reason: 'start' }),
    ).resolves.toMatchObject({ status: 'executing', previousStatus: 'approved' });
  });
});
