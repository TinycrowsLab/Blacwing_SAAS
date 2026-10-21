// Idempotency-Key against a real Valkey (API-008, #60): replay, conflict, the in-flight race, lock and
// result TTLs, the owner-checked scripts and the fail-closed outage. Needs Docker (Testcontainers).

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';
import { type ValkeyHandle, withValkey } from '@blackwing/testing/containers';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { hashIdempotencyKey, idempotencyStorageKey, requestFingerprint } from './fingerprint.js';
import { ThingLog, type ThingBody, thingsModule } from './fixtures.test-helpers.js';
import { ValkeyIdempotencyStore } from './valkey-store.js';

import type { InProgressRecord } from './record.js';
import type { Problem } from '@blackwing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let valkey: ValkeyHandle;
let raw: ReturnType<ValkeyHandle['createClient']>;
let app: NestFastifyApplication;
let log: ThingLog;
let store: ValkeyIdempotencyStore;

const LOCK_TTL_S = 1;
const RESULT_TTL_S = 2;
const MS_PER_SECOND = 1000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  valkey = await withValkey();
  // A client without the handle's key prefix, to inspect the raw keys the store wrote.
  raw = valkey.createClient({ keyPrefix: '' });
  store = new ValkeyIdempotencyStore(valkey.client);
  log = new ThingLog();
  const created = await createApiApp({
    config: loadApiConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
      API_IDEMPOTENCY_LOCK_TTL_S: String(LOCK_TTL_S),
      API_IDEMPOTENCY_TTL_S: String(RESULT_TTL_S),
    }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    idempotencyStore: store,
    imports: [thingsModule(log)],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  raw.disconnect();
  await valkey.stop();
});

const post = (key: string, body: ThingBody = { name: 'one' }, tenant = 'tenant-a') =>
  app.inject({
    method: 'POST',
    url: '/v1/things',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-test-tenant': tenant,
    },
    payload: body,
  });

const freshKey = (): string => `int-${randomUUID()}`;
const storageKeyOf = (key: string, tenant = 'tenant-a'): string =>
  `${valkey.keyPrefix}${idempotencyStorageKey(tenant, '/v1/things', hashIdempotencyKey(key))}`;

describe('with a real Valkey', () => {
  it('replays the stored response and creates once', async () => {
    const key = freshKey();
    const before = log.created;
    const first = await post(key);
    const second = await post(key);
    expect(first.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body).toBe(first.body);
    expect(log.created - before).toBe(1);
  });

  it('stores under idem:{tenant}:{route}:{sha256(key)} with a TTL, and never the raw key', async () => {
    const key = freshKey();
    await post(key);
    const stored = storageKeyOf(key);
    const value = await raw.get(stored);
    expect(value).not.toBeNull();
    expect(value ?? '').not.toContain(key);
    expect(JSON.parse(value ?? '{}')).toMatchObject({ state: 'completed' });
    const ttl = await raw.pttl(stored);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(RESULT_TTL_S * MS_PER_SECOND);
    const scan = await raw.keys(`${valkey.keyPrefix}idem:*`);
    expect(scan.every((k) => !k.includes(key))).toBe(true);
  });

  it('rejects the same key with a different body as idempotency_conflict', async () => {
    const key = freshKey();
    await post(key, { name: 'one' });
    const res = await post(key, { name: 'two' });
    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('idempotency_conflict');
  });

  it('lets exactly one of many concurrent duplicates proceed', async () => {
    const key = freshKey();
    const before = log.created;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => post(key, { name: 'race', delayMs: 250 })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(rejected).toHaveLength(11);
    expect(rejected.every((r) => r.json<Problem>().code === 'idempotency_in_progress')).toBe(true);
    expect(log.created - before).toBe(1);
  });

  it('isolates tenants that use the same key', async () => {
    const key = freshKey();
    const before = log.created;
    const a = await post(key, { name: 'a' }, 'tenant-a');
    const b = await post(key, { name: 'b' }, 'tenant-b');
    expect(b.headers['idempotency-replayed']).toBeUndefined();
    expect(b.json<{ name: string }>().name).toBe('b');
    expect(a.statusCode).toBe(201);
    expect(log.created - before).toBe(2);
    expect(await raw.exists(storageKeyOf(key, 'tenant-a'), storageKeyOf(key, 'tenant-b'))).toBe(2);
  });

  it('does not cache a 5xx: the marker is gone and a retry runs again', async () => {
    const key = freshKey();
    const before = log.attempts;
    expect((await post(key, { name: 'x', mode: 'boom' })).statusCode).toBe(500);
    expect(await raw.exists(storageKeyOf(key))).toBe(0);
    expect((await post(key, { name: 'x', mode: 'boom' })).statusCode).toBe(500);
    expect(log.attempts - before).toBe(2);
  });

  it('treats an expired result as a new key', async () => {
    const key = freshKey();
    const before = log.created;
    await post(key);
    await sleep(RESULT_TTL_S * MS_PER_SECOND + 300);
    const again = await post(key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBeUndefined();
    expect(log.created - before).toBe(2);
  });

  it('recovers from a crash between the work and the stored result once the lock TTL passes', async () => {
    const key = freshKey();
    const body: ThingBody = { name: 'crashed' };
    // The first process took the marker and died: nobody will ever complete it.
    const deadMarker: InProgressRecord = {
      state: 'in_progress',
      keyHash: hashIdempotencyKey(key),
      fingerprint: requestFingerprint({
        method: 'POST',
        path: '/v1/things',
        query: '',
        rawBody: JSON.stringify(body),
      }),
      token: 'dead-process',
      startedAt: new Date().toISOString(),
    };
    const route = idempotencyStorageKey('tenant-a', '/v1/things', hashIdempotencyKey(key));
    expect(await store.acquire(route, deadMarker, LOCK_TTL_S * MS_PER_SECOND)).toEqual({
      acquired: true,
    });

    const blocked = await post(key, body);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<Problem>().code).toBe('idempotency_in_progress');

    await sleep(LOCK_TTL_S * MS_PER_SECOND + 300);
    const retried = await post(key, body);
    expect(retried.statusCode).toBe(201);
    expect(retried.headers['idempotency-replayed']).toBeUndefined();
  });
});

describe('owner-checked scripts', () => {
  const marker = (token: string): InProgressRecord => ({
    state: 'in_progress',
    keyHash: hashIdempotencyKey('k'),
    fingerprint: requestFingerprint({ method: 'POST', path: '/p', query: '', rawBody: '' }),
    token,
    startedAt: new Date().toISOString(),
  });
  const done = (key: string) => ({
    state: 'completed' as const,
    keyHash: hashIdempotencyKey(key),
    fingerprint: marker('x').fingerprint,
    result: { kind: 'stored' as const, status: 201, headers: {}, body: '{}' },
    completedAt: new Date().toISOString(),
  });

  it('only the owner completes or releases an in_progress marker', async () => {
    const key = `idem:script:${randomUUID()}`;
    await store.acquire(key, marker('owner'), 5000);
    expect(await store.complete(key, 'intruder', done('k'), 5000)).toBe(false);
    expect(await store.release(key, 'intruder')).toBe(false);
    expect(await store.acquire(key, marker('other'), 5000)).toMatchObject({ acquired: false });
    expect(await store.complete(key, 'owner', done('k'), 5000)).toBe(true);
    // A completed record is never released or completed again.
    expect(await store.release(key, 'owner')).toBe(false);
    expect(await store.complete(key, 'owner', done('k'), 5000)).toBe(false);
  });

  it('release frees the key for a new acquire', async () => {
    const key = `idem:script:${randomUUID()}`;
    await store.acquire(key, marker('owner'), 5000);
    expect(await store.release(key, 'owner')).toBe(true);
    expect(await store.acquire(key, marker('next'), 5000)).toEqual({ acquired: true });
  });

  it('does nothing for a key that expired', async () => {
    const key = `idem:script:${randomUUID()}`;
    await store.acquire(key, marker('owner'), 200);
    await sleep(400);
    expect(await store.complete(key, 'owner', done('k'), 5000)).toBe(false);
    expect(await raw.exists(`${valkey.keyPrefix}${key}`)).toBe(0);
  });
});

describe('Valkey outage', () => {
  it('fails closed with 503 idempotency_unavailable and creates nothing', async () => {
    const dead = valkey.createClient();
    dead.disconnect();
    const created = await createApiApp({
      config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
      logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
      idempotencyStore: new ValkeyIdempotencyStore(dead),
      imports: [thingsModule(log)],
    });
    try {
      await created.app.getHttpAdapter().getInstance().ready();
      const before = log.attempts;
      const res = await created.app.inject({
        method: 'POST',
        url: '/v1/things',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': freshKey(),
          'x-test-tenant': 'tenant-a',
        },
        payload: { name: 'never' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<Problem>().code).toBe('idempotency_unavailable');
      expect(log.attempts).toBe(before);
    } finally {
      await created.app.close();
    }
  });
});
