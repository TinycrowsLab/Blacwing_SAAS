import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { hashIdempotencyKey, idempotencyStorageKey, requestFingerprint } from './fingerprint.js';
import { InMemoryIdempotencyStore } from './memory.js';
import { createIdempotencyMetrics } from './metrics.js';
import { IdempotencyService, type BeginInput, type BeginOutcome } from './service.js';
import { ApiProblemError } from '../errors/problem-errors.js';

import type { AcquireResult, IdempotencyStore } from './ports.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

function setup(overrides: { store?: IdempotencyStore | null } = {}) {
  let now = 1_000_000;
  const memory = new InMemoryIdempotencyStore(() => now);
  const registry = new Registry();
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  let tokens = 0;
  const service = new IdempotencyService({
    store: overrides.store === undefined ? memory : overrides.store,
    ttlSeconds: 100,
    lockTtlSeconds: 10,
    maxBodyBytes: 1000,
    metrics: createIdempotencyMetrics(registry),
    logger,
    now: () => new Date(now),
    newToken: () => `token-${String((tokens += 1))}`,
  });
  return {
    service,
    memory,
    registry,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const request = (overrides: Partial<BeginInput> = {}): BeginInput => ({
  tenantId: 't1',
  route: '/v1/runs',
  method: 'POST',
  path: '/v1/runs',
  query: '',
  rawBody: '{"asset":"a1"}',
  key: 'client-key-0001',
  ...overrides,
});

async function refusal(promise: Promise<BeginOutcome>): Promise<ApiProblemError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiProblemError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const ok = { status: 201, headers: JSON_HEADERS, payload: '{"id":"run_1"}' };

describe('state transitions', () => {
  it('absent -> in_progress -> completed -> replay', async () => {
    const { service, memory } = setup();
    const first = await service.begin(request());
    expect(first.kind).toBe('proceed');
    if (first.kind !== 'proceed') return;
    const key = first.pending.storageKey;
    expect(memory.peek(key)).toMatchObject({ state: 'in_progress', token: 'token-1' });

    await service.finish(first.pending, ok);
    expect(memory.peek(key)).toMatchObject({
      state: 'completed',
      result: { kind: 'stored', status: 201, body: '{"id":"run_1"}' },
    });

    const second = await service.begin(request());
    expect(second).toMatchObject({
      kind: 'replay',
      result: { status: 201, body: '{"id":"run_1"}' },
    });
  });

  it('records the key hash and fingerprint, never the key', async () => {
    const { service, memory } = setup();
    const outcome = await service.begin(request());
    if (outcome.kind !== 'proceed') throw new Error('expected proceed');
    const stored = memory.peek(outcome.pending.storageKey);
    expect(stored).toMatchObject({
      keyHash: hashIdempotencyKey('client-key-0001'),
      fingerprint: requestFingerprint(request()),
    });
    expect(JSON.stringify(stored)).not.toContain('client-key-0001');
    expect(outcome.pending.storageKey).toBe(
      idempotencyStorageKey('t1', '/v1/runs', hashIdempotencyKey('client-key-0001')),
    );
  });

  it('a duplicate while in_progress is refused with in_progress and a Retry-After', async () => {
    const { service } = setup();
    await service.begin(request());
    const error = await refusal(service.begin(request()));
    expect(error.problemCode).toBe('idempotency_in_progress');
    expect(error.retryAfterSeconds).toBe(1);
  });

  it('a non-cacheable result releases the marker so the retry proceeds', async () => {
    const { service, memory } = setup();
    const first = await service.begin(request());
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await service.finish(first.pending, { ...ok, status: 503 });
    expect(memory.keys()).toHaveLength(0);
    expect((await service.begin(request())).kind).toBe('proceed');
  });

  it('abandon drops the marker', async () => {
    const { service, memory } = setup();
    const first = await service.begin(request());
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await service.abandon(first.pending);
    expect(memory.keys()).toHaveLength(0);
  });

  it('a different fingerprint is idempotency_conflict in every state', async () => {
    const { service } = setup();
    const first = await service.begin(request());
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    const other = request({ rawBody: '{"asset":"a2"}' });
    expect((await refusal(service.begin(other))).problemCode).toBe('idempotency_conflict');
    await service.finish(first.pending, ok);
    expect((await refusal(service.begin(other))).problemCode).toBe('idempotency_conflict');
  });
});

describe('TTL logic', () => {
  it('the stored result lives for the TTL, then the key is new', async () => {
    const { service, advance } = setup();
    const first = await service.begin(request());
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await service.finish(first.pending, ok);
    advance(99_999);
    expect((await service.begin(request())).kind).toBe('replay');
    advance(2);
    expect((await service.begin(request())).kind).toBe('proceed');
  });

  it('a crashed first request (never completed) blocks only until the lock TTL', async () => {
    const { service, advance } = setup();
    await service.begin(request()); // the process dies here
    advance(9_999);
    expect((await refusal(service.begin(request()))).problemCode).toBe('idempotency_in_progress');
    advance(2);
    const retry = await service.begin(request());
    expect(retry.kind).toBe('proceed');
  });

  it('a request that outlived its lock cannot overwrite the retry that replaced it', async () => {
    const { service, memory, advance } = setup();
    const slow = await service.begin(request());
    advance(10_001); // the lock expired
    const retry = await service.begin(request());
    if (slow.kind !== 'proceed' || retry.kind !== 'proceed') throw new Error('expected proceed');
    await service.finish(slow.pending, { ...ok, payload: '{"id":"from-slow"}' });
    expect(memory.peek(retry.pending.storageKey)).toMatchObject({
      state: 'in_progress',
      token: retry.pending.token,
    });
    await service.finish(retry.pending, { ...ok, payload: '{"id":"from-retry"}' });
    expect(await service.begin(request())).toMatchObject({
      kind: 'replay',
      result: { body: '{"id":"from-retry"}' },
    });
  });

  it('a late release by the old request does not delete the retry marker', async () => {
    const { service, memory, advance } = setup();
    const slow = await service.begin(request());
    advance(10_001);
    const retry = await service.begin(request());
    if (slow.kind !== 'proceed' || retry.kind !== 'proceed') throw new Error('expected proceed');
    await service.finish(slow.pending, { ...ok, status: 500 });
    expect(memory.peek(retry.pending.storageKey)?.state).toBe('in_progress');
  });
});

describe('omitted results', () => {
  it('an oversized 2xx completes the key but replays as idempotency_result_too_large', async () => {
    const { service, memory } = setup();
    const first = await service.begin(request());
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await service.finish(first.pending, {
      ...ok,
      payload: JSON.stringify({ x: 'y'.repeat(2000) }),
    });
    expect(memory.peek(first.pending.storageKey)).toMatchObject({
      state: 'completed',
      result: { kind: 'omitted', status: 201, reason: 'too_large' },
    });
    const error = await refusal(service.begin(request()));
    expect(error.problemCode).toBe('idempotency_result_too_large');
    expect(error.detail).toContain('201');
  });
});

describe('failing closed', () => {
  const throwing = (): IdempotencyStore => ({
    acquire: () => Promise.reject(new Error('boom')),
    complete: () => Promise.reject(new Error('boom')),
    release: () => Promise.reject(new Error('boom')),
  });

  it('a store error on acquire is idempotency_unavailable (503 semantics) with the cause kept off the wire', async () => {
    const { service, registry } = setup({ store: throwing() });
    const error = await refusal(service.begin(request()));
    expect(error.problemCode).toBe('idempotency_unavailable');
    expect(error.retryAfterSeconds).toBe(5);
    expect(error.detail).not.toContain('boom');
    expect(await registry.getSingleMetricAsString('idempotency_store_errors_total')).toMatch(
      /operation="acquire"\} 1/,
    );
  });

  it('no store is unavailable too', async () => {
    const { service } = setup({ store: null });
    expect((await refusal(service.begin(request()))).problemCode).toBe('idempotency_unavailable');
  });

  it('a corrupt record in the store is unavailable, never replayed or overwritten', async () => {
    const corrupt: IdempotencyStore = {
      acquire: () => Promise.reject(new Error('corrupt')),
      complete: () => Promise.resolve(false),
      release: () => Promise.resolve(false),
    };
    const { service } = setup({ store: corrupt });
    expect((await refusal(service.begin(request()))).problemCode).toBe('idempotency_unavailable');
  });

  it('gives up when the key keeps expiring between the failed set and the read', async () => {
    const flapping: IdempotencyStore = {
      acquire: () => Promise.resolve<AcquireResult>({ acquired: false, existing: null }),
      complete: () => Promise.resolve(false),
      release: () => Promise.resolve(false),
    };
    const acquire = vi.spyOn(flapping, 'acquire');
    const { service } = setup({ store: flapping });
    expect((await refusal(service.begin(request()))).problemCode).toBe('idempotency_unavailable');
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it('finish and abandon never throw when the store is down', async () => {
    const { service } = setup({ store: throwing() });
    const pending = { storageKey: 'k', token: 't', keyHash: 'h', fingerprint: 'f', route: '/r' };
    await expect(service.finish(pending, ok)).resolves.toBeUndefined();
    await expect(service.finish(pending, { ...ok, status: 500 })).resolves.toBeUndefined();
    await expect(service.abandon(pending)).resolves.toBeUndefined();
  });
});

describe('header validation', () => {
  it.each([undefined, '', '   '])('a missing key (%j) is idempotency_key_required', async (key) => {
    const { service, memory } = setup();
    const error = await refusal(service.begin(request({ key })));
    expect(error.problemCode).toBe('idempotency_key_required');
    expect(memory.keys()).toHaveLength(0);
  });

  it.each(['short', 'has space inside', ['two-values-1', 'two-values-2'], 'x'.repeat(256)])(
    'an invalid key (%j) is bad_request',
    async (key) => {
      const { service } = setup();
      expect((await refusal(service.begin(request({ key })))).problemCode).toBe('bad_request');
    },
  );
});

describe('logging', () => {
  it('logs replays with the route, and never the key or the body', async () => {
    const { service, logger } = setup();
    const info = vi.spyOn(logger, 'info');
    const first = await service.begin(request());
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await service.finish(first.pending, ok);
    await service.begin(request());
    expect(info).toHaveBeenCalledWith({ route: '/v1/runs', status: 201 }, 'idempotency.replay');
    expect(JSON.stringify(info.mock.calls)).not.toContain('client-key-0001');
    expect(JSON.stringify(info.mock.calls)).not.toContain('run_1');
  });
});
