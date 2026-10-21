import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import {
  BIG_BLOB_LENGTH,
  ThingLog,
  thingsModule,
  type ThingBody,
} from './fixtures.test-helpers.js';
import { InMemoryIdempotencyStore } from './memory.js';

import type { IdempotencyStore } from './ports.js';
import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { Problem } from '@blackwing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const KEY = 'order-key-0001';

let app: NestFastifyApplication;
let metrics: HttpMetrics;
let log: ThingLog;
let store: InMemoryIdempotencyStore;
let now: number;

async function boot(
  options: { store?: IdempotencyStore | null; env?: Record<string, string> } = {},
): Promise<void> {
  log = new ThingLog();
  now = 1_700_000_000_000;
  store = new InMemoryIdempotencyStore(() => now);
  const chosen = options.store === undefined ? store : options.store;
  const created = await createApiApp({
    config: loadApiConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
      ...options.env,
    }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    ...(chosen === null ? {} : { idempotencyStore: chosen }),
    imports: [thingsModule(log)],
  });
  app = created.app;
  metrics = created.metrics;
  await app.getHttpAdapter().getInstance().ready();
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
});

interface PostOptions {
  readonly key?: string | null;
  readonly tenant?: string | null;
  readonly url?: string;
  readonly body?: ThingBody | string;
}

function post(options: PostOptions = {}) {
  const key = options.key === undefined ? KEY : options.key;
  const tenant = options.tenant === undefined ? 'tenant-a' : options.tenant;
  const body = options.body ?? { name: 'one' };
  return app.inject({
    method: 'POST',
    url: options.url ?? '/v1/things',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
      ...(tenant === null ? {} : { 'x-test-tenant': tenant }),
    },
    payload: body,
  });
}

const metric = async (name: string): Promise<string> =>
  metrics.registry.getSingleMetricAsString(name);

describe('Idempotency-Key replay', () => {
  it('same key and same body twice: one creation, the second returns the stored response', async () => {
    const first = await post();
    const second = await post();
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body).toBe(first.body);
    expect(second.headers['content-type']).toBe(first.headers['content-type']);
    expect(log.created).toBe(1);
    expect(log.attempts).toBe(1);
    expect(await metric('idempotency_hits_total')).toMatch(
      /idempotency_hits_total\{route="\/v1\/things"\} 1/,
    );
  });

  it('replays the original status of a route with a custom status', async () => {
    const first = await post({ url: '/v1/things/accepted' });
    const second = await post({ url: '/v1/things/accepted' });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(log.created).toBe(1);
  });

  it('treats JSON member order and whitespace as the same request', async () => {
    const first = await post({ body: '{"name":"one","mode":"ok"}' });
    const second = await post({ body: '{ "mode": "ok",\n "name": "one" }' });
    expect(first.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(log.created).toBe(1);
  });

  it('replays many times while the result is kept, then treats an expired key as new', async () => {
    await post();
    expect((await post()).headers['idempotency-replayed']).toBe('true');
    now += 86_400_000 - 1;
    expect((await post()).headers['idempotency-replayed']).toBe('true');
    now += 2;
    const afterExpiry = await post();
    expect(afterExpiry.statusCode).toBe(201);
    expect(afterExpiry.headers['idempotency-replayed']).toBeUndefined();
    expect(log.created).toBe(2);
  });

  it('honours API_IDEMPOTENCY_TTL_S', async () => {
    await app.close();
    await boot({ env: { API_IDEMPOTENCY_TTL_S: '10' } });
    await post();
    now += 11_000;
    expect((await post()).headers['idempotency-replayed']).toBeUndefined();
    expect(log.created).toBe(2);
  });

  it('keys are scoped per route template: the same key on another route is a new request', async () => {
    const created = await post();
    const exported = await post({ url: '/v1/things/t-1/exports' });
    expect(created.statusCode).toBe(201);
    expect(exported.statusCode).toBe(201);
    expect(exported.headers['idempotency-replayed']).toBeUndefined();
    expect(log.created).toBe(2);
  });

  it('replays the original Location and ETag, with a fresh x-request-id', async () => {
    const first = await post({ url: '/v1/things/located' });
    const second = await post({ url: '/v1/things/located' });
    expect(first.headers.location).toBe('/v1/things/7');
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.headers.location).toBe('/v1/things/7');
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.headers['x-request-id']).toBeDefined();
    expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
  });

  it('does not touch routes that are not @Idempotent()', async () => {
    const res = await post({ url: '/v1/things/plain/create', key: null });
    expect(res.statusCode).toBe(201);
    expect(store.keys()).toHaveLength(0);
  });
});

describe('Idempotency-Key conflicts', () => {
  it('same key with a different body is 409 idempotency_conflict and does not run the handler', async () => {
    await post({ body: { name: 'one' } });
    const res = await post({ body: { name: 'two' } });
    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('idempotency_conflict');
    expect(log.attempts).toBe(1);
    expect(await metric('idempotency_conflicts_total')).toMatch(
      /idempotency_conflicts_total\{route="\/v1\/things"\} 1/,
    );
  });

  it('same key with a different path or query is a conflict', async () => {
    await post({ url: '/v1/things?dry_run=true' });
    const res = await post({ url: '/v1/things?dry_run=false' });
    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('idempotency_conflict');
  });

  it('reordered query parameters are the same request', async () => {
    await post({ url: '/v1/things?a=1&b=2' });
    const res = await post({ url: '/v1/things?b=2&a=1' });
    expect(res.headers['idempotency-replayed']).toBe('true');
  });

  it('a different body while the first request runs is a conflict, not in_progress', async () => {
    const slow = post({ body: { name: 'one', delayMs: 150 } });
    await new Promise((r) => setTimeout(r, 40));
    const other = await post({ body: { name: 'two' } });
    expect(other.json<Problem>().code).toBe('idempotency_conflict');
    await slow;
  });

  it('concurrent duplicates: exactly one proceeds, the others get 409 idempotency_in_progress', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post({ body: { name: 'race', delayMs: 120 } })),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(rejected).toHaveLength(7);
    for (const res of rejected) {
      expect(res.json<Problem>().code).toBe('idempotency_in_progress');
      expect(res.headers['retry-after']).toBe('1');
    }
    expect(log.created).toBe(1);
    expect(await metric('idempotency_inflight_total')).toMatch(
      /idempotency_inflight_total\{route="\/v1\/things"\} 7/,
    );
    // After completion the same key replays.
    const later = await post({ body: { name: 'race', delayMs: 120 } });
    expect(later.headers['idempotency-replayed']).toBe('true');
  });
});

describe('Idempotency-Key header', () => {
  it('missing on an @Idempotent() route is 400 idempotency_key_required', async () => {
    const res = await post({ key: null });
    expect(res.statusCode).toBe(400);
    expect(res.json<Problem>().code).toBe('idempotency_key_required');
    expect(log.attempts).toBe(0);
  });

  it.each([
    ['too short', 'short'],
    ['not visible ASCII', 'key with spaces 123'],
    ['several values', 'aaaaaaaa, bbbbbbbb'],
    ['non-ASCII', 'clé-clé-clé-clé'],
  ])('a malformed key (%s) is 400 and never reaches the store', async (_name, key) => {
    const res = await post({ key });
    expect(res.statusCode).toBe(400);
    expect(res.json<Problem>().code).toBe('bad_request');
    expect(log.attempts).toBe(0);
    expect(store.keys()).toHaveLength(0);
  });

  it('a blank key counts as missing', async () => {
    const res = await post({ key: '   ' });
    expect(res.json<Problem>().code).toBe('idempotency_key_required');
  });
});

describe('what is cached', () => {
  it('does not cache 5xx: a retry runs the handler again', async () => {
    const first = await post({ body: { name: 'b', mode: 'boom' } });
    const second = await post({ body: { name: 'b', mode: 'boom' } });
    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(500);
    expect(second.headers['idempotency-replayed']).toBeUndefined();
    expect(log.attempts).toBe(2);
    expect(store.keys()).toHaveLength(0);
  });

  it('a 5xx followed by a successful retry creates once, then replays', async () => {
    const body: ThingBody = { name: 'b', mode: 'boom-once' };
    expect((await post({ body })).statusCode).toBe(500);
    const retry = await post({ body });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBeUndefined();
    const replay = await post({ body });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(log.created).toBe(1);
    expect(log.attempts).toBe(2);
  });

  it('caches a deterministic 4xx (422) byte for byte', async () => {
    const body: ThingBody = { name: 'bad', mode: 'invalid' };
    const first = await post({ body });
    const second = await post({ body });
    expect(first.statusCode).toBe(422);
    expect(second.statusCode).toBe(422);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.headers['content-type']).toContain('application/problem+json');
    expect(second.body).toBe(first.body);
    expect(log.attempts).toBe(1);
  });

  it('does not cache a state-dependent 409 conflict from the handler', async () => {
    const body: ThingBody = { name: 'taken', mode: 'conflict' };
    expect((await post({ body })).statusCode).toBe(409);
    const again = await post({ body });
    expect(again.statusCode).toBe(409);
    expect(again.headers['idempotency-replayed']).toBeUndefined();
    expect(log.attempts).toBe(2);
  });

  it('an oversized response is flagged: the first caller gets it, a replay is 409 idempotency_result_too_large', async () => {
    await app.close();
    await boot({ env: { API_IDEMPOTENCY_MAX_BODY_BYTES: '1000' } });
    const body: ThingBody = { name: 'big', mode: 'big' };
    const first = await post({ body });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ blob: string }>().blob).toHaveLength(BIG_BLOB_LENGTH);
    const replay = await post({ body });
    expect(replay.statusCode).toBe(409);
    expect(replay.json<Problem>().code).toBe('idempotency_result_too_large');
    expect(log.created).toBe(1);
  });

  it('redacts secrets before storing: the store never holds them and a replay shows the placeholder', async () => {
    const body: ThingBody = { name: 'sec', mode: 'secret' };
    const first = await post({ body });
    expect(first.json<{ token: string }>().token).toBe('bwk_live_super-secret-value');
    const stored = JSON.stringify(store.peek(store.keys()[0] ?? ''));
    expect(stored).not.toContain('bwk_live_super-secret-value');
    expect(stored).not.toContain('k-123');
    const replay = await post({ body });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).not.toContain('bwk_live_super-secret-value');
    expect(replay.json<{ token: string; name: string }>()).toMatchObject({
      token: '[REDACTED]',
      name: 'sec',
    });
  });
});

describe('tenant isolation', () => {
  it('the same key in two tenants never collides: both create, neither sees the other result', async () => {
    const a = await post({ tenant: 'tenant-a', body: { name: 'a' } });
    const b = await post({ tenant: 'tenant-b', body: { name: 'b' } });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotency-replayed']).toBeUndefined();
    expect(b.json<{ name: string }>().name).toBe('b');
    expect(log.created).toBe(2);
    const keys = store.keys();
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.startsWith('idem:tenant-a:/v1/things:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('idem:tenant-b:/v1/things:'))).toBe(true);
  });

  it('the same key and body in two tenants replays only within each tenant', async () => {
    await post({ tenant: 'tenant-a' });
    expect((await post({ tenant: 'tenant-b' })).headers['idempotency-replayed']).toBeUndefined();
    expect((await post({ tenant: 'tenant-a' })).headers['idempotency-replayed']).toBe('true');
    expect((await post({ tenant: 'tenant-b' })).headers['idempotency-replayed']).toBe('true');
    expect(log.created).toBe(2);
  });

  it('stores only the hash of the key, never the key itself', async () => {
    await post({ key: 'very-secret-client-key-xyz' });
    for (const key of store.keys()) {
      expect(key).not.toContain('very-secret-client-key-xyz');
      expect(JSON.stringify(store.peek(key))).not.toContain('very-secret-client-key-xyz');
    }
  });

  it('refuses (fail closed) when the request has no tenant context', async () => {
    const res = await post({ tenant: null });
    expect(res.statusCode).toBe(403);
    expect(res.json<Problem>().code).toBe('tenant_context_missing');
    expect(log.attempts).toBe(0);
    expect(store.keys()).toHaveLength(0);
  });
});

describe('store outage', () => {
  const failing = (): IdempotencyStore => ({
    acquire: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:6379 password=hunter2')),
    complete: () => Promise.reject(new Error('down')),
    release: () => Promise.reject(new Error('down')),
  });

  it('fails closed with 503 idempotency_unavailable and runs no handler', async () => {
    await app.close();
    await boot({ store: failing() });
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json<Problem>().code).toBe('idempotency_unavailable');
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.body).not.toContain('hunter2');
    expect(log.attempts).toBe(0);
    expect(await metric('idempotency_store_errors_total')).toMatch(
      /idempotency_store_errors_total\{operation="acquire"\} 1/,
    );
  });

  it('fails closed when no store is wired at all', async () => {
    await app.close();
    await boot({ store: null });
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json<Problem>().code).toBe('idempotency_unavailable');
    expect(log.attempts).toBe(0);
  });

  it('still reports the missing header (400) when the store is down', async () => {
    await app.close();
    await boot({ store: failing() });
    expect((await post({ key: null })).json<Problem>().code).toBe('idempotency_key_required');
  });

  it('a failure to store the result does not fail the response that was already produced', async () => {
    await app.close();
    const inner = new InMemoryIdempotencyStore();
    const flaky: IdempotencyStore = {
      acquire: (key, record, ttl) => inner.acquire(key, record, ttl),
      complete: () => Promise.reject(new Error('down')),
      release: (key, token) => inner.release(key, token),
    };
    await boot({ store: flaky });
    const res = await post();
    expect(res.statusCode).toBe(201);
    expect(log.created).toBe(1);
    expect(await metric('idempotency_store_errors_total')).toMatch(
      /idempotency_store_errors_total\{operation="complete"\} 1/,
    );
  });
});
