// The session store and the single-flight refresh against a real Valkey (IAM-002, #334): sealed
// records, TTLs, the owner-checked lock script and two replicas sharing one session. Needs Docker
// (Testcontainers); the unit suites cover the same logic on an in-memory fake.

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ValkeyHandle, withValkey } from '@blackwing/testing/containers';

import { fakeOidc, sessionRecord, tokens } from './auth.test-helpers.js';
import { KEY_BYTES } from './seal.js';
import { createAuthService } from './service.js';
import { adaptRedis, createSessionStore } from './session-store.js';

let valkey: ValkeyHandle;
const keys: readonly [Buffer, ...Buffer[]] = [randomBytes(KEY_BYTES)];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  valkey = await withValkey();
});
afterAll(async () => {
  await valkey.stop();
});

function storeOn(client = valkey.createClient()) {
  return createSessionStore(adaptRedis(client), keys, () => Date.now());
}

describe('session store on Valkey', () => {
  it('stores the record sealed, with a TTL, and deletes it', async () => {
    const store = storeOn();
    const raw = valkey.createClient();
    await store.create('int-1', sessionRecord, 60_000);
    expect(await store.get('int-1')).toEqual(sessionRecord);
    const stored = await raw.get('bw:web:sess:int-1');
    expect(stored).not.toContain('plain-access-token');
    expect(await raw.pttl('bw:web:sess:int-1')).toBeGreaterThan(0);
    await store.delete('int-1');
    expect(await store.get('int-1')).toBeNull();
  });

  it('expires a session by itself', async () => {
    const store = storeOn();
    await store.create('int-2', sessionRecord, 200);
    await sleep(350);
    expect(await store.get('int-2')).toBeNull();
    expect(await store.replace('int-2', sessionRecord, 1000)).toBe(false);
  });

  it('keeps the lock exclusive across clients and releases it only for its owner', async () => {
    const a = storeOn();
    const b = storeOn();
    expect(await a.tryLock('int-3', 'owner-a', 5000)).toBe(true);
    expect(await b.tryLock('int-3', 'owner-b', 5000)).toBe(false);
    await b.unlock('int-3', 'owner-b');
    expect(await b.tryLock('int-3', 'owner-b', 5000)).toBe(false);
    await a.unlock('int-3', 'owner-a');
    expect(await b.tryLock('int-3', 'owner-b', 5000)).toBe(true);
    await b.unlock('int-3', 'owner-b');
  });
});

describe('refresh across replicas', () => {
  it('refreshes once when two replicas see the same expiring session', async () => {
    const oidc = fakeOidc();
    let release: () => void = () => undefined;
    oidc.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(tokens({ accessToken: 'access-token-2' }));
          };
        }),
    );
    const replica = () =>
      createAuthService({
        config: { consoleOrigin: 'https://app.example.com', sessionKeys: keys },
        oidc,
        store: storeOn(),
        metrics: { login: () => undefined, refresh: () => undefined, logout: () => undefined },
        audit: () => undefined,
        now: () => Date.now(),
        sleep,
      });
    const [one, two] = [replica(), replica()];

    const started = await one.startLogin(null);
    const state = new URL(started.location).searchParams.get('state') ?? '';
    oidc.exchangeCode.mockResolvedValueOnce(tokens({ expiresInSeconds: 1 }));
    const outcome = await one.completeLogin({
      code: 'c',
      state,
      idpError: undefined,
      loginCookie: started.loginCookie,
    });
    if (!outcome.ok) throw new Error('login failed');

    // The 1 s access token is inside the refresh skew, so both replicas want to refresh it.
    const pending = [
      one.authenticate(outcome.sessionCookie),
      two.authenticate(outcome.sessionCookie),
    ];
    await sleep(150);
    release();
    const results = await Promise.all(pending);
    expect(oidc.refresh).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toMatchObject({ status: 'ok', record: { accessToken: 'access-token-2' } });
    }
  });
});
