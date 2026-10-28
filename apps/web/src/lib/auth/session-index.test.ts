import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Clock, memoryValkey, sessionRecord } from './auth.test-helpers.js';
import { KEY_BYTES } from './seal.js';
import { createSessionStore, MAX_SESSION_TTL_MS } from './session-store.js';

function setup() {
  const clock = new Clock();
  const valkey = memoryValkey(clock);
  const keys: readonly [Buffer, ...Buffer[]] = [randomBytes(KEY_BYTES)];
  return { clock, valkey, keys, store: createSessionStore(valkey, keys, clock.read) };
}

const member = (valkey: ReturnType<typeof memoryValkey>, key: string): string[] =>
  [...(valkey.sets.get(key)?.members ?? [])].sort();

describe('session index', () => {
  it('lists a new session under its user, tenant and Keycloak session', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', { ...sessionRecord, idpSid: 'kc-1' }, 60_000);
    expect(member(valkey, 'bw:web:sess-idx:user:user-1')).toEqual(['sid-1']);
    expect(member(valkey, 'bw:web:sess-idx:tenant:tenant-1')).toEqual(['sid-1']);
    expect(member(valkey, 'bw:web:sess-idx:idp:kc-1')).toEqual(['sid-1']);
  });

  it('keeps an index alive for the longest session lifetime', async () => {
    const { store, valkey, clock } = setup();
    await store.create('sid-1', sessionRecord, 60_000);
    expect(valkey.sets.get('bw:web:sess-idx:user:user-1')?.expiresAt).toBe(
      clock.now + MAX_SESSION_TTL_MS,
    );
  });

  it('removes a deleted session from its indexes', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', { ...sessionRecord, idpSid: 'kc-1' }, 60_000);
    await store.create('sid-2', sessionRecord, 60_000);
    await store.delete('sid-1');
    expect(member(valkey, 'bw:web:sess-idx:user:user-1')).toEqual(['sid-2']);
    expect(member(valkey, 'bw:web:sess-idx:idp:kc-1')).toEqual([]);
  });

  it('moves a refreshed session to the tenant the ID token now names', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', sessionRecord, 60_000);
    expect(await store.replace('sid-1', { ...sessionRecord, tenantId: 'tenant-2' }, 60_000)).toBe(
      true,
    );
    expect(member(valkey, 'bw:web:sess-idx:tenant:tenant-1')).toEqual([]);
    expect(member(valkey, 'bw:web:sess-idx:tenant:tenant-2')).toEqual(['sid-1']);
  });

  it('does not index a refresh that lost the race to a revocation', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', sessionRecord, 60_000);
    await store.delete('sid-1');
    expect(await store.replace('sid-1', { ...sessionRecord, tenantId: 'tenant-9' }, 60_000)).toBe(
      false,
    );
    expect(member(valkey, 'bw:web:sess-idx:tenant:tenant-9')).toEqual([]);
  });

  it('revokes by user and by tenant, and only the sessions it names', async () => {
    const { store } = setup();
    await store.create('a', sessionRecord, 60_000);
    await store.create('b', { ...sessionRecord, sub: 'user-2' }, 60_000);
    await store.create('c', { ...sessionRecord, tenantId: 'tenant-2' }, 60_000);

    // user-1 holds sessions in both tenants: a user revocation without a tenant takes both.
    const byUser = await store.revokeWhere({ kind: 'user', sub: 'user-1' }, () => true);
    expect(byUser.map((r) => r.tenantId).sort()).toEqual(['tenant-1', 'tenant-2']);
    expect(await store.get('a')).toBeNull();
    expect(await store.get('c')).toBeNull();
    expect(await store.get('b')).not.toBeNull();

    const byTenant = await store.revokeWhere({ kind: 'tenant', tenantId: 'tenant-1' }, () => true);
    expect(byTenant.map((r) => r.sub)).toEqual(['user-2']);
    expect(await store.get('b')).toBeNull();
  });

  it('applies the match inside an index, so a user in one tenant keeps the other', async () => {
    const { store } = setup();
    await store.create('a', sessionRecord, 60_000);
    await store.create('b', { ...sessionRecord, tenantId: 'tenant-2' }, 60_000);
    const revoked = await store.revokeWhere(
      { kind: 'user', sub: 'user-1' },
      (r) => r.tenantId === 'tenant-2',
    );
    expect(revoked.map((r) => r.tenantId)).toEqual(['tenant-2']);
    expect(await store.get('a')).not.toBeNull();
  });

  it('prunes index members whose record is gone without revoking anything else', async () => {
    const { store, valkey } = setup();
    await store.create('live', sessionRecord, 60_000);
    valkey.data.delete('bw:web:sess:live');
    await store.create('other', sessionRecord, 60_000);
    const revoked = await store.revokeWhere({ kind: 'user', sub: 'user-1' }, () => true);
    expect(revoked.map((r) => r.sub)).toEqual(['user-1']);
    expect(member(valkey, 'bw:web:sess-idx:user:user-1')).toEqual([]);
  });

  it('never revokes a record that was copied under another session id', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', sessionRecord, 60_000);
    const copied = valkey.data.get('bw:web:sess:sid-1');
    if (copied === undefined) throw new Error('missing');
    valkey.data.set('bw:web:sess:sid-2', copied);
    valkey.sets.get('bw:web:sess-idx:user:user-1')?.members.add('sid-2');
    const revoked = await store.revokeWhere({ kind: 'user', sub: 'user-1' }, () => true);
    expect(revoked.length).toBe(1);
    expect(valkey.data.has('bw:web:sess:sid-2')).toBe(true);
  });

  it('walks a large tenant in bounded batches, not one command per session', async () => {
    const { store, valkey } = setup();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await store.create(`s${String(i).padStart(3, '0')}`, sessionRecord, 60_000);
    }
    valkey.commands = 0;
    const revoked = await store.revokeWhere({ kind: 'tenant', tenantId: 'tenant-1' }, () => true);
    expect(revoked).toHaveLength(total);
    expect(member(valkey, 'bw:web:sess-idx:tenant:tenant-1')).toEqual([]);
    // 250 sessions in pages of 100: three SSCAN pages, each a constant number of commands.
    expect(valkey.commands).toBeLessThan(total / 2);
  });

  it('returns an empty result for an unknown index', async () => {
    const { store } = setup();
    expect(await store.revokeWhere({ kind: 'idp', sid: 'nope' }, () => true)).toEqual([]);
  });

  it('claims a token id exactly once within its ttl', async () => {
    const { store, clock } = setup();
    expect(await store.claimOnce('jti-1', 1000)).toBe(true);
    expect(await store.claimOnce('jti-1', 1000)).toBe(false);
    expect(await store.claimOnce('jti-2', 1000)).toBe(true);
    clock.advance(1000);
    expect(await store.claimOnce('jti-1', 1000)).toBe(true);
  });

  it('reports a Valkey outage on revocation and on the new index operations', async () => {
    const { store, valkey } = setup();
    await store.create('sid-1', sessionRecord, 60_000);
    valkey.failing = true;
    await expect(store.revokeWhere({ kind: 'user', sub: 'user-1' }, () => true)).rejects.toThrow(
      'The session store is unavailable',
    );
    await expect(store.claimOnce('jti', 1000)).rejects.toThrow('The session store is unavailable');
  });
});
