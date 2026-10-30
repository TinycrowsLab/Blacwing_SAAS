import { describe, expect, it, vi } from 'vitest';

import {
  type BrokerGate2ExceptionRequest,
  type Gate2Exception,
  type Gate2ExceptionCreate,
  GATE2_ACTION_SUMMARY_MAX,
  GATE2_EXCEPTION_RAISED_SIGNAL,
} from '@blackwing/contracts';
import { AppError, ConflictError } from '@blackwing/errors';
import { createUuidV7Generator } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import {
  createGate2ExceptionPort,
  createTemporalGate2Signaler,
  type Gate2RaiseStore,
  type Gate2RunSignaler,
  idempotencyKeyFromHeader,
  runStatusOf,
  truncateSummary,
} from './gate2.js';
import { createBrokerMetrics } from './metrics.js';

const gen = createUuidV7Generator();
const TENANT = gen();
const RUN = gen();
const SESSION = gen();
const NOW_MS = 1_800_000_000_000;
const TIMEOUT_MINUTES = 30;
const KEY = 'hook-call-0001';

function exceptionFor(create: Gate2ExceptionCreate, id = gen()): Gate2Exception {
  return {
    id,
    tenantId: TENANT,
    runId: RUN,
    sessionId: SESSION,
    subtaskId: null,
    testCaseId: null,
    toolName: create.toolName,
    proposedAction: create.proposedAction,
    envelopeReason: create.envelopeReason,
    intrusiveness: create.intrusiveness,
    batch: create.batch ?? false,
    state: 'pending',
    stateVersion: 0,
    requesterId: null,
    planApproverId: null,
    decidedBy: null,
    decidedAt: null,
    timeoutAt: create.timeoutAt,
    idempotencyKey: create.idempotencyKey,
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
  };
}

const BODY: BrokerGate2ExceptionRequest = {
  sessionId: SESSION,
  subtaskId: null,
  testCaseId: null,
  toolName: 'nmap.scan',
  proposedActionSummary: '{"target":"10.0.0.9","ports":"1-1024"}',
  envelopeReason: 'target outside the approved envelope',
  intrusiveness: 'active_safe',
  batch: false,
};

/** A store that remembers one row per idempotency key, as the database's unique index does. */
function memoryStore() {
  const rows = new Map<string, Gate2Exception>();
  const calls: Gate2ExceptionCreate[] = [];
  const store: Gate2RaiseStore = {
    raise: vi.fn((_ref, create: Gate2ExceptionCreate) => {
      calls.push(create);
      const existing = rows.get(create.idempotencyKey);
      if (existing !== undefined) return Promise.resolve({ exception: existing, created: false });
      const exception = exceptionFor(create);
      rows.set(create.idempotencyKey, exception);
      return Promise.resolve({ exception, created: true });
    }),
  };
  return { store, rows, calls };
}

function signaler(fail = false) {
  const signalRaised = vi.fn<Gate2RunSignaler['signalRaised']>(() =>
    fail ? Promise.reject(new Error('temporal down')) : Promise.resolve(),
  );
  return { signaler: { signalRaised } satisfies Gate2RunSignaler, signalRaised };
}

function portWith(store: Gate2RaiseStore, sig: Gate2RunSignaler, metrics = createBrokerMetrics()) {
  return createGate2ExceptionPort({
    store,
    signaler: sig,
    timeoutMinutes: TIMEOUT_MINUTES,
    metrics,
    logger: createLogger('api', { level: 'silent' }),
    now: () => NOW_MS,
  });
}

const REF = { tenantId: TENANT, runId: RUN, sessionId: SESSION };

/** The error a synchronous call throws, or `undefined` when it returns. Keeps assertions out of branches. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('truncateSummary', () => {
  it('keeps a summary within the limit untouched', () => {
    expect(truncateSummary('short')).toEqual({ text: 'short', truncated: false });
  });

  it('cuts an oversized summary to the byte limit and marks it truncated', () => {
    const big = 'a'.repeat(GATE2_ACTION_SUMMARY_MAX + 10);
    const out = truncateSummary(big);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text, 'utf8')).toBe(GATE2_ACTION_SUMMARY_MAX);
  });

  it('never splits a multi-byte character at the cut', () => {
    // 4095 ASCII bytes then a 3-byte character straddling the 4096-byte boundary.
    const text = `${'a'.repeat(4095)}€€`;
    const out = truncateSummary(text, 4096);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe('a'.repeat(4095));
    expect(out.text.includes('�')).toBe(false);
  });
});

describe('idempotencyKeyFromHeader', () => {
  it('returns a printable ASCII key', () => {
    expect(idempotencyKeyFromHeader(KEY)).toBe(KEY);
    expect(idempotencyKeyFromHeader(['first', 'second'])).toBe('first');
  });

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a key with a space', 'bad key'],
    ['a key over 255 characters', 'k'.repeat(256)],
    ['a key with control characters', 'a\u0001b'],
  ])('refuses %s with IDEMPOTENCY_KEY_REQUIRED', (_name, raw) => {
    expect(thrownBy(() => idempotencyKeyFromHeader(raw))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  });
});

describe('runStatusOf', () => {
  const base = { id: RUN, stateVersion: 4, pauseReason: null, resumeTo: null };

  it('reads an executing run as-is', () => {
    expect(runStatusOf({ ...base, state: 'executing' })).toEqual({
      state: 'executing',
      version: 4,
    });
  });

  it('reads a paused run with its reason and resume target', () => {
    expect(
      runStatusOf({
        ...base,
        state: 'paused',
        pauseReason: 'gate2_pending',
        resumeTo: 'executing',
      }),
    ).toEqual({ state: 'paused', reason: 'gate2_pending', resumeTo: 'executing', version: 4 });
  });

  it('refuses a paused row with no reason rather than guessing one', () => {
    expect(() => runStatusOf({ ...base, state: 'paused', resumeTo: 'executing' })).toThrow(
      ConflictError,
    );
  });

  it('refuses a paused row with no resume target', () => {
    expect(() => runStatusOf({ ...base, state: 'paused', pauseReason: 'gate2_pending' })).toThrow(
      ConflictError,
    );
  });
});

describe('createGate2ExceptionPort', () => {
  it('stores one pending exception, with the summary and the server-computed timeout', async () => {
    const { store, calls } = memoryStore();
    const { signaler: sig } = signaler();
    const response = await portWith(store, sig).raise({
      ref: REF,
      body: BODY,
      idempotencyKey: KEY,
    });
    expect(response.state).toBe('pending');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId: RUN,
      sessionId: SESSION,
      toolName: 'nmap.scan',
      intrusiveness: 'active_safe',
      batch: false,
      idempotencyKey: KEY,
      proposedAction: { summary: BODY.proposedActionSummary, truncated: false },
      timeoutAt: new Date(NOW_MS + TIMEOUT_MINUTES * 60_000).toISOString(),
    });
  });

  it('truncates an oversized proposed action before it reaches the store', async () => {
    const { store, calls } = memoryStore();
    const { signaler: sig } = signaler();
    const body = { ...BODY, proposedActionSummary: 'x'.repeat(GATE2_ACTION_SUMMARY_MAX * 3) };
    await portWith(store, sig).raise({ ref: REF, body, idempotencyKey: KEY });
    expect(calls[0]?.proposedAction).toEqual({
      summary: 'x'.repeat(GATE2_ACTION_SUMMARY_MAX),
      truncated: true,
    });
  });

  it('a retry with the same key returns the same exception and does not count it twice', async () => {
    const { store, rows } = memoryStore();
    const { signaler: sig } = signaler();
    const metrics = createBrokerMetrics();
    const port = portWith(store, sig, metrics);
    const first = await port.raise({ ref: REF, body: BODY, idempotencyKey: KEY });
    const second = await port.raise({ ref: REF, body: BODY, idempotencyKey: KEY });
    expect(second).toEqual(first);
    expect(rows.size).toBe(1);
    const counted = await metrics.registry.getSingleMetricAsString(
      'gate2_exceptions_created_total',
    );
    expect(counted).toContain('gate2_exceptions_created_total{batch="false"} 1');
  });

  it('signals the run workflow with the exception id on every attempt, including a replay', async () => {
    const { store } = memoryStore();
    const { signaler: sig, signalRaised } = signaler();
    const port = portWith(store, sig);
    const first = await port.raise({ ref: REF, body: BODY, idempotencyKey: KEY });
    await port.raise({ ref: REF, body: BODY, idempotencyKey: KEY });
    expect(signalRaised).toHaveBeenCalledTimes(2);
    expect(signalRaised).toHaveBeenLastCalledWith(
      { tenantId: TENANT, runId: RUN },
      first.exceptionId,
    );
  });

  it('answers 503 TEMPORAL_UNAVAILABLE when the signal cannot be delivered (fail closed)', async () => {
    const { store } = memoryStore();
    const { signaler: sig } = signaler(true);
    const err = await portWith(store, sig)
      .raise({ ref: REF, body: BODY, idempotencyKey: KEY })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('TEMPORAL_UNAVAILABLE');
    expect((err as AppError).httpStatus).toBe(503);
  });

  it('refuses a body that names another session, and stores nothing', async () => {
    const { store, calls } = memoryStore();
    const { signaler: sig, signalRaised } = signaler();
    const body = { ...BODY, sessionId: gen() };
    await expect(
      portWith(store, sig).raise({ ref: REF, body, idempotencyKey: KEY }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toHaveLength(0);
    expect(signalRaised).not.toHaveBeenCalled();
  });

  it('propagates a refusal from the store (a killed or unknown run) without signalling', async () => {
    const refused: Gate2RaiseStore = {
      raise: () => Promise.reject(new AppError('RUN_NOT_ACTIVE', 'run is not active')),
    };
    const { signaler: sig, signalRaised } = signaler();
    await expect(
      portWith(refused, sig).raise({ ref: REF, body: BODY, idempotencyKey: KEY }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_ACTIVE' });
    expect(signalRaised).not.toHaveBeenCalled();
  });
});

describe('createTemporalGate2Signaler', () => {
  it('signals the execution workflow of the run with the exception payload', async () => {
    const signal = vi.fn<(workflowId: string, name: string, arg: unknown) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const sig = createTemporalGate2Signaler({ signal });
    const exceptionId = gen();
    await sig.signalRaised({ tenantId: TENANT, runId: RUN }, exceptionId);
    expect(signal).toHaveBeenCalledWith(`execution-${RUN}`, GATE2_EXCEPTION_RAISED_SIGNAL, {
      exceptionId,
    });
  });
});
