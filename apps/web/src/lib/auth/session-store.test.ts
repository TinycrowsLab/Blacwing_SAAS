import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Clock, memoryValkey, sessionRecord } from './auth.test-helpers.js';
import { KEY_BYTES } from './seal.js';
import { createSessionStore, SessionStoreUnavailableError } from './session-store.js';

const record = sessionRecord;

function setup() {
  const clock = new Clock();
  const valkey = memoryValkey(clock);
  const keys: readonly [Buffer, ...Buffer[]] = [randomBytes(KEY_BYTES)];
  return { clock, valkey, keys, store: createSessionStore(valkey, keys, clock.read) };
}

describe('session store', () => {
  it('round-trips a record and never stores a token in clear', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', record, 60_000);
    expect(await store.get('sid-1')).toEqual(record);
    const stored = [...valkey.data.values()].map((entry) => entry.value).join('');
    for (const secret of ['plain-access-token', 'plain-refresh-token', 'plain-id-token']) {
      expect(stored).not.toContain(secret);
      expect(Buffer.from(stored, 'base64url').toString('utf8')).not.toContain(secret);
    }
  });

  it('forgets a session when its ttl passes', async () => {
    const { store, clock } = setup();
    await store.create('sid-1', record, 1000);
    clock.advance(1000);
    expect(await store.get('sid-1')).toBeNull();
  });

  it('does not open a record copied under another session id', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', record, 60_000);
    const copied = valkey.data.get('bw:web:sess:sid-1');
    if (copied === undefined) throw new Error('missing');
    valkey.data.set('bw:web:sess:sid-2', copied);
    expect(await store.get('sid-2')).toBeNull();
  });

  it('treats corrupt or foreign values as absent', async () => {
    const { store, valkey, clock } = setup();
    valkey.data.set('bw:web:sess:sid-1', { value: 'garbage', expiresAt: clock.now + 1000 });
    expect(await store.get('sid-1')).toBeNull();
    const other = createSessionStore(valkey, [randomBytes(KEY_BYTES)], clock.read);
    await other.create('sid-3', record, 1000);
    expect(await store.get('sid-3')).toBeNull();
  });

  it('keeps sessions across a key rotation', async () => {
    const { valkey, clock, keys, store } = setup();
    await store.create('sid-1', record, 60_000);
    const rotated = createSessionStore(valkey, [randomBytes(KEY_BYTES), keys[0]], clock.read);
    expect(await rotated.get('sid-1')).toEqual(record);
  });

  it('create never overwrites, replace only updates an existing session', async () => {
    const { store } = setup();
    expect(await store.replace('sid-1', record, 1000)).toBe(false);
    await store.create('sid-1', record, 1000);
    await store.create('sid-1', { ...record, sub: 'attacker' }, 1000);
    expect((await store.get('sid-1'))?.sub).toBe('user-1');
    expect(await store.replace('sid-1', { ...record, accessToken: 'next' }, 1000)).toBe(true);
    expect((await store.get('sid-1'))?.accessToken).toBe('next');
    await store.delete('sid-1');
    expect(await store.replace('sid-1', record, 1000)).toBe(false);
    expect(await store.get('sid-1')).toBeNull();
  });

  it('locks per session: one owner, released only by that owner, expiring on its own', async () => {
    const { store, clock } = setup();
    expect(await store.tryLock('sid-1', 'a', 1000)).toBe(true);
    expect(await store.tryLock('sid-1', 'b', 1000)).toBe(false);
    expect(await store.tryLock('sid-2', 'b', 1000)).toBe(true);
    await store.unlock('sid-1', 'b');
    expect(await store.tryLock('sid-1', 'c', 1000)).toBe(false);
    await store.unlock('sid-1', 'a');
    expect(await store.tryLock('sid-1', 'c', 1000)).toBe(true);
    clock.advance(1000);
    expect(await store.tryLock('sid-1', 'd', 1000)).toBe(true);
  });

  it('reports a Valkey outage as unavailable on every operation', async () => {
    const { store, valkey } = setup();
    valkey.failing = true;
    for (const call of [
      () => store.create('sid-1', record, 1000),
      () => store.get('sid-1'),
      () => store.replace('sid-1', record, 1000),
      () => store.delete('sid-1'),
      () => store.tryLock('sid-1', 'a', 1000),
      () => store.unlock('sid-1', 'a'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(SessionStoreUnavailableError);
    }
  });
});
