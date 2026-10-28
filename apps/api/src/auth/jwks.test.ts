import { exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey } from 'jose';
import { describe, expect, it } from 'vitest';

import { JwksUnavailableError } from './errors.js';
import { createJwksCache, MAX_JWKS_BYTES } from './jwks.js';

const TTL_MS = 600_000;
const COOLDOWN_MS = 30_000;

/** A public JWK for a fresh RS256 key, with the given kid. */
async function publicJwk(kid: string): Promise<JWK> {
  const { publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
}

/** A fake IdP whose published key set and availability the test controls. */
function fakeIdp(initialKeys: JWK[]) {
  const state: {
    keys: JWK[];
    calls: number;
    failure: 'none' | 'down' | 'status' | 'oversized' | 'bad';
  } = {
    keys: initialKeys,
    calls: 0,
    failure: 'none',
  };
  const respond = (): Promise<Response> => {
    state.calls += 1;
    switch (state.failure) {
      case 'down':
        return Promise.reject(new TypeError('fetch failed'));
      case 'status':
        return Promise.resolve(new Response('nope', { status: 503 }));
      case 'oversized':
        return Promise.resolve(new Response('x'.repeat(MAX_JWKS_BYTES + 1)));
      case 'bad':
        return Promise.resolve(new Response('{"keys":"not-a-list"}'));
      case 'none':
        return Promise.resolve(
          new Response(JSON.stringify({ keys: state.keys }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
    }
  };
  const fetchImpl: typeof fetch = () => respond();
  return { state, fetchImpl };
}

function harness(initialKeys: JWK[]) {
  const idp = fakeIdp(initialKeys);
  let now = 1_000_000;
  let fetches = 0;
  const cache = createJwksCache({
    url: 'https://idp.example.test/certs',
    ttlMs: TTL_MS,
    refetchCooldownMs: COOLDOWN_MS,
    timeoutMs: 3000,
    now: () => now,
    fetch: idp.fetchImpl,
    onFetch: () => {
      fetches += 1;
    },
  });
  return {
    idp,
    cache,
    advance: (ms: number) => {
      now += ms;
    },
    fetches: () => fetches,
  };
}

/** Looks up a key by kid the way `jose` does during verification. */
async function lookup(resolve: JWTVerifyGetKey, kid: string): Promise<unknown> {
  return await resolve({ alg: 'RS256', kid }, { payload: 'e30', signature: 'c2ln' });
}

describe('JWKS cache', () => {
  it('fetches once and reuses the key set within the TTL', async () => {
    const h = harness([await publicJwk('k1')]);
    await lookup(h.cache.resolve, 'k1');
    await lookup(h.cache.resolve, 'k1');
    await lookup(h.cache.resolve, 'k1');
    expect(h.fetches()).toBe(1);
  });

  it('shares one in-flight fetch between concurrent cold lookups', async () => {
    const h = harness([await publicJwk('k1')]);
    await Promise.all([1, 2, 3, 4, 5].map(() => lookup(h.cache.resolve, 'k1')));
    expect(h.fetches()).toBe(1);
  });

  it('handles a rotated signing key: an unknown kid refetches once and then validates', async () => {
    const original = await publicJwk('old');
    const rotated = await publicJwk('new');
    const h = harness([original]);
    await lookup(h.cache.resolve, 'old');
    h.idp.state.keys = [rotated];
    h.advance(COOLDOWN_MS);
    await expect(lookup(h.cache.resolve, 'new')).resolves.toBeDefined();
    expect(h.fetches()).toBe(2);
  });

  it('bounds refetches on unknown kids: a flood of forged kids refetches at most once per cooldown', async () => {
    const h = harness([await publicJwk('k1')]);
    await lookup(h.cache.resolve, 'k1');
    // Still inside the cooldown from the first fetch: none of these may reach the IdP.
    for (let i = 0; i < 50; i += 1) {
      await expect(lookup(h.cache.resolve, `forged-${String(i)}`)).rejects.toThrow();
    }
    expect(h.fetches()).toBe(1);
    h.advance(COOLDOWN_MS);
    await expect(lookup(h.cache.resolve, 'forged-x')).rejects.toThrow();
    expect(h.fetches()).toBe(2);
    await expect(lookup(h.cache.resolve, 'forged-y')).rejects.toThrow();
    expect(h.fetches()).toBe(2);
  });

  it('refreshes the key set once the TTL has passed', async () => {
    const h = harness([await publicJwk('k1')]);
    await lookup(h.cache.resolve, 'k1');
    h.advance(TTL_MS);
    await lookup(h.cache.resolve, 'k1');
    expect(h.fetches()).toBe(2);
  });

  it('keeps serving the cached keys when the IdP is down after a successful fetch', async () => {
    const h = harness([await publicJwk('k1')]);
    await lookup(h.cache.resolve, 'k1');
    h.idp.state.failure = 'down';
    h.advance(TTL_MS);
    await expect(lookup(h.cache.resolve, 'k1')).resolves.toBeDefined();
    expect(h.fetches()).toBe(2);
  });

  it('fails closed with no cache: an unreachable IdP is JwksUnavailableError', async () => {
    const h = harness([await publicJwk('k1')]);
    h.idp.state.failure = 'down';
    await expect(lookup(h.cache.resolve, 'k1')).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('does not hammer a down IdP: a cold cache still refetches only after the cooldown', async () => {
    const h = harness([await publicJwk('k1')]);
    h.idp.state.failure = 'down';
    await expect(lookup(h.cache.resolve, 'k1')).rejects.toBeInstanceOf(JwksUnavailableError);
    await expect(lookup(h.cache.resolve, 'k1')).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(h.fetches()).toBe(1);
    h.advance(COOLDOWN_MS);
    h.idp.state.failure = 'none';
    await expect(lookup(h.cache.resolve, 'k1')).resolves.toBeDefined();
    expect(h.fetches()).toBe(2);
  });

  it.each([
    ['a non-success status', 'status'],
    ['an oversized document', 'oversized'],
    ['a document of the wrong shape', 'bad'],
  ] as const)('treats %s as an outage when cold', async (_name, failure) => {
    const h = harness([await publicJwk('k1')]);
    h.idp.state.failure = failure;
    await expect(lookup(h.cache.resolve, 'k1')).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('keeps the previous key set when a refresh returns a bad document', async () => {
    const h = harness([await publicJwk('k1')]);
    await lookup(h.cache.resolve, 'k1');
    h.idp.state.failure = 'bad';
    h.advance(TTL_MS);
    await expect(lookup(h.cache.resolve, 'k1')).resolves.toBeDefined();
  });
});
