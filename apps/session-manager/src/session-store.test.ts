// Unit tests of the encrypted per-role session store (SESSION-004). The envelope is the real `@blackwing/secrets`
// envelope; the KEK is a fake Transit, the persistence is an in-memory port with the same rules as the
// `role_sessions` table (one row per scope, scrubbed material on revoke or expiry), and the Valkey mirror and audit
// are recorders. The real Postgres RLS and constraints are proven in `packages/db/src/role-sessions.rls.int.test.ts`.

import { trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { STORED_SESSION_MAX_MATERIAL_BYTES, type StoredSessionKey } from '@blackwing/contracts';
import { AppError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';
import {
  createEnvelopeCrypto,
  type EnvelopeCrypto,
  EnvelopeError,
  type TransitClient,
} from '@blackwing/secrets';

import {
  createSessionStore,
  EXPIRY_SKEW_MS,
  mirrorKey,
  type RoleSessionAuditEvent,
  type SessionPort,
  type SessionStoreOp,
  type StoredSessionRecord,
} from './session-store.js';

import type { RoleSessionWrite } from '@blackwing/db';

const PLAINTEXT = 'sid=SUPER-SECRET-COOKIE-VALUE; Path=/';
const TTL_SECONDS = 1800;

/** Fake OpenBao Transit: wraps the DEK reversibly and can be switched off to simulate an outage. */
function fakeTransit(): TransitClient & { down: boolean } {
  const transit = {
    down: false,
    encrypt(key: string, plaintextB64: string): Promise<string> {
      if (transit.down) return Promise.reject(new AppError('KEK_UNAVAILABLE', 'transit down'));
      const body = Buffer.from(JSON.stringify({ key, pt: plaintextB64 })).toString('base64');
      return Promise.resolve(`vault:v1:${body}`);
    },
    decrypt(key: string, ciphertext: string): Promise<string> {
      if (transit.down) return Promise.reject(new AppError('KEK_UNAVAILABLE', 'transit down'));
      const body = JSON.parse(
        Buffer.from(ciphertext.slice('vault:v1:'.length), 'base64').toString('utf8'),
      ) as { key: string; pt: string };
      if (body.key !== key) return Promise.reject(new AppError('KEK_UNAVAILABLE', 'wrong key'));
      return Promise.resolve(body.pt);
    },
    rewrap(_key: string, ciphertext: string): Promise<string> {
      return Promise.resolve(ciphertext);
    },
  };
  return transit;
}

/** In-memory port: one record per scope, the same rules as the table (see `role-sessions.repository.ts`). */
function memoryPort() {
  const rows = new Map<
    string,
    StoredSessionRecord & { tenantId: string; runId: string; assetId: string; roleName: string }
  >();
  const scope = (key: StoredSessionKey) =>
    `${key.tenantId}|${key.runId}|${key.assetId}|${key.roleName}`;
  const port: SessionPort = {
    upsert(write: RoleSessionWrite) {
      rows.set(scope(write.key), {
        id: write.id,
        status: 'active',
        expiresAt: write.expiresAt,
        encMaterial: write.encMaterial,
        tenantId: write.key.tenantId,
        runId: write.key.runId,
        assetId: write.key.assetId,
        roleName: write.key.roleName,
      });
      return Promise.resolve();
    },
    find(key: StoredSessionKey) {
      const row = rows.get(scope(key));
      return Promise.resolve(row ?? null);
    },
    setStatus(key: StoredSessionKey, status: 'expired' | 'revoked') {
      const row = rows.get(scope(key));
      if (row === undefined || row.status === status) return Promise.resolve(false);
      rows.set(scope(key), { ...row, status, encMaterial: Buffer.alloc(0) });
      return Promise.resolve(true);
    },
    revokeRun(tenantId: string, runId: string) {
      const changed: { assetId: string; roleName: string }[] = [];
      for (const [k, row] of rows) {
        if (row.tenantId === tenantId && row.runId === runId && row.status !== 'revoked') {
          rows.set(k, { ...row, status: 'revoked', encMaterial: Buffer.alloc(0) });
          changed.push({ assetId: row.assetId, roleName: row.roleName });
        }
      }
      return Promise.resolve(changed);
    },
    countActive(tenantId: string) {
      let live = 0;
      for (const row of rows.values()) {
        if (row.tenantId === tenantId && (row.status === 'active' || row.status === 'refreshing'))
          live += 1;
      }
      return Promise.resolve(live);
    },
  };
  return { port, rows };
}

function setup(overrides: { ttlSeconds?: number; mirrorFails?: boolean } = {}) {
  const transit = fakeTransit();
  const envelope: EnvelopeCrypto = createEnvelopeCrypto({ transit });
  const { port, rows } = memoryPort();
  const mirrorState = new Map<string, string>();
  const mirror = {
    set: vi.fn((key: string, value: string) => {
      if (overrides.mirrorFails === true) return Promise.reject(new Error('valkey down'));
      mirrorState.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      mirrorState.delete(key);
      return Promise.resolve();
    }),
  };
  const events: RoleSessionAuditEvent[] = [];
  const ops: SessionStoreOp[] = [];
  const active = new Map<string, number>();
  let now = new Date('2026-10-31T10:00:00.000Z');
  const store = createSessionStore({
    sessions: port,
    envelope,
    mirror,
    audit: {
      emit: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    logger: createLogger('session-manager', {
      level: 'silent',
      destination: { write: () => undefined },
    }),
    tracer: trace.getTracer('test'),
    ttlSeconds: overrides.ttlSeconds ?? TTL_SECONDS,
    onError: (op) => {
      ops.push(op);
    },
    onActiveCount: (tenantId, count) => {
      active.set(tenantId, count);
    },
    clock: () => now,
  });
  return {
    store,
    transit,
    rows,
    mirror,
    mirrorState,
    events,
    ops,
    active,
    setNow(next: Date) {
      now = next;
    },
  };
}

const scope = (): StoredSessionKey => ({
  tenantId: newId(),
  runId: newId(),
  assetId: newId(),
  roleName: 'admin',
});

const put = (
  store: ReturnType<typeof setup>['store'],
  key: StoredSessionKey,
  overrides: Partial<{
    material: Uint8Array;
    kind: 'cookie' | 'bearer' | 'header' | 'storage';
    runWindowEndsAt: Date;
  }> = {},
) =>
  store.put(key, {
    kind: overrides.kind ?? 'cookie',
    material: overrides.material ?? Buffer.from(PLAINTEXT, 'utf8'),
    runWindowEndsAt: overrides.runWindowEndsAt ?? new Date('2026-10-31T18:00:00.000Z'),
  });

/** The `SM_SESSION_EXPIRED` code of a rejected promise, or the rejection itself when it is not one. */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }
  return 'resolved';
}

describe('put and get', () => {
  it('round-trips the material to the caller, and zeroes its buffer when the callback settles', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    let captured: Buffer | undefined;
    const text = await t.store.get(key, (material) => {
      captured = material;
      return Promise.resolve(material.toString('utf8'));
    });
    expect(text).toBe(PLAINTEXT);
    expect(captured?.every((byte) => byte === 0)).toBe(true);
  });

  it('stores ciphertext only: the row holds no plaintext, and the key ref names the tenant KEK', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    const row = [...t.rows.values()][0];
    expect(row).toBeDefined();
    const stored = row?.encMaterial.toString('utf8') ?? '';
    expect(stored).not.toContain('SUPER-SECRET-COOKIE-VALUE');
    expect(stored).not.toContain(Buffer.from(PLAINTEXT).toString('base64'));
    const envelope = JSON.parse(stored) as Record<string, unknown>;
    expect(envelope).toMatchObject({ v: 1, alg: 'AES-256-GCM', kekKey: `tenant-${key.tenantId}` });
    expect(envelope).not.toHaveProperty('dek');
  });

  it('expires at the TTL when the run window is later, and never after the run window end', async () => {
    const t = setup({ ttlSeconds: 1800 });
    const later = scope();
    const result = await put(t.store, later, {
      runWindowEndsAt: new Date('2026-10-31T18:00:00.000Z'),
    });
    expect(result.expiresAt.toISOString()).toBe('2026-10-31T10:30:00.000Z');

    const capped = scope();
    const cut = await put(t.store, capped, {
      runWindowEndsAt: new Date('2026-10-31T10:05:00.000Z'),
    });
    expect(cut.expiresAt.toISOString()).toBe('2026-10-31T10:05:00.000Z');
  });

  it('refuses to store when the run window is already closed, and writes nothing', async () => {
    const t = setup();
    const code = await rejectionCode(
      put(t.store, scope(), { runWindowEndsAt: new Date('2026-10-31T09:59:00.000Z') }),
    );
    expect(code).toBe('SM_SESSION_EXPIRED');
    expect(t.rows.size).toBe(0);
  });

  it('a second put for the same scope replaces the session (last writer wins, one record)', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key, { material: Buffer.from('first-token-value', 'utf8'), kind: 'bearer' });
    await put(t.store, key, { material: Buffer.from('second-token-value', 'utf8') });
    expect(t.rows.size).toBe(1);
    const seen = await t.store.get(key, (material) => Promise.resolve(material.toString('utf8')));
    expect(seen).toBe('second-token-value');
  });

  it('refuses material above the size cap, and writes nothing', async () => {
    const t = setup();
    const code = await rejectionCode(
      put(t.store, scope(), { material: new Uint8Array(STORED_SESSION_MAX_MATERIAL_BYTES + 1) }),
    );
    expect(code).toBe('SECRET_TOO_LARGE');
    expect(t.rows.size).toBe(0);
  });

  it('accepts material of exactly the cap', async () => {
    const t = setup();
    await expect(
      put(t.store, scope(), { material: new Uint8Array(STORED_SESSION_MAX_MATERIAL_BYTES) }),
    ).resolves.toBeDefined();
  });

  it('refuses an unknown kind and a malformed scope before any encryption or write', async () => {
    const t = setup();
    const badKind = await rejectionCode(put(t.store, scope(), { kind: 'password' as 'cookie' }));
    expect(badKind).toBe('VALIDATION_FAILED');
    const badRole = await rejectionCode(put(t.store, { ...scope(), roleName: 'role:admin' }));
    expect(badRole).toBe('VALIDATION_FAILED');
    const badTenant = await rejectionCode(put(t.store, { ...scope(), tenantId: 'not-a-uuid' }));
    expect(badTenant).toBe('VALIDATION_FAILED');
    expect(t.rows.size).toBe(0);
    expect(t.transit.down).toBe(false);
  });

  it('fails closed when Transit is down on put: no plaintext fallback, no write', async () => {
    const t = setup();
    t.transit.down = true;
    const code = await rejectionCode(put(t.store, scope()));
    expect(code).toBe('KEK_UNAVAILABLE');
    expect(t.rows.size).toBe(0);
    expect(t.ops).toEqual(['put']);
  });

  it('a mirror failure does not fail the put (Postgres is the source of truth)', async () => {
    const t = setup({ mirrorFails: true });
    const key = scope();
    await expect(put(t.store, key)).resolves.toBeDefined();
    const seen = await t.store.get(key, (material) => Promise.resolve(material.toString('utf8')));
    expect(seen).toBe(PLAINTEXT);
  });

  it('writes the Valkey mirror as metadata and a pointer, under the documented key', async () => {
    const t = setup();
    const key = scope();
    const result = await put(t.store, key);
    const value = t.mirrorState.get(mirrorKey(key));
    expect(value).toBeDefined();
    expect(JSON.parse(value ?? '{}')).toEqual({
      id: result.id,
      status: 'active',
      expiresAt: result.expiresAt.toISOString(),
    });
    expect(value).not.toContain('SUPER-SECRET');
    expect(mirrorKey(key)).toBe(`sm:sess:${key.tenantId}:${key.runId}:${key.assetId}:admin`);
  });

  it('records a stored audit event with metadata only', async () => {
    const t = setup();
    await put(t.store, scope());
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({
      type: 'role_session.stored',
      kind: 'cookie',
      roleName: 'admin',
    });
    expect(JSON.stringify(t.events)).not.toContain('SUPER-SECRET');
  });
});

describe('get refusals', () => {
  it('an absent session is SM_SESSION_EXPIRED and never calls the callback', async () => {
    const t = setup();
    const use = vi.fn(() => Promise.resolve('x'));
    const code = await rejectionCode(t.store.get(scope(), use));
    expect(code).toBe('SM_SESSION_EXPIRED');
    expect(use).not.toHaveBeenCalled();
  });

  it("another tenant's session is invisible: SM_SESSION_EXPIRED", async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    const code = await rejectionCode(
      t.store.get({ ...key, tenantId: newId() }, () => Promise.resolve(1)),
    );
    expect(code).toBe('SM_SESSION_EXPIRED');
  });

  it('a session past its TTL is marked expired, its material scrubbed, and not returned', async () => {
    const t = setup({ ttlSeconds: 60 });
    const key = scope();
    await put(t.store, key);
    t.setNow(new Date('2026-10-31T10:02:00.000Z'));
    const use = vi.fn(() => Promise.resolve(1));
    const code = await rejectionCode(t.store.get(key, use));
    expect(code).toBe('SM_SESSION_EXPIRED');
    expect(use).not.toHaveBeenCalled();
    const row = [...t.rows.values()][0];
    expect(row).toMatchObject({ status: 'expired' });
    expect(row?.encMaterial.length).toBe(0);
    expect(t.mirrorState.size).toBe(0);
  });

  it('treats a session within the clock-skew margin of expiry as expired (fail safe)', async () => {
    const t = setup({ ttlSeconds: 60 });
    const key = scope();
    await put(t.store, key);
    t.setNow(new Date(new Date('2026-10-31T10:01:00.000Z').getTime() - EXPIRY_SKEW_MS + 1));
    const code = await rejectionCode(t.store.get(key, () => Promise.resolve(1)));
    expect(code).toBe('SM_SESSION_EXPIRED');
  });

  it('still serves a session just before the skew margin', async () => {
    const t = setup({ ttlSeconds: 60 });
    const key = scope();
    await put(t.store, key);
    t.setNow(new Date(new Date('2026-10-31T10:01:00.000Z').getTime() - EXPIRY_SKEW_MS - 1000));
    await expect(t.store.get(key, () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('a corrupted stored envelope fails closed with ENVELOPE_INVALID and never calls the callback', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    const row = [...t.rows.values()][0];
    if (row === undefined) throw new Error('row missing');
    t.rows.set([...t.rows.keys()][0] ?? '', { ...row, encMaterial: Buffer.from('not json') });
    const use = vi.fn(() => Promise.resolve(1));
    await expect(t.store.get(key, use)).rejects.toBeInstanceOf(EnvelopeError);
    expect(use).not.toHaveBeenCalled();
  });

  it('a tampered ciphertext fails authentication (SECRET_DECRYPT_FAILED) and zeroes nothing it returns', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    const k = [...t.rows.keys()][0] ?? '';
    const row = t.rows.get(k);
    if (row === undefined) throw new Error('row missing');
    const envelope = JSON.parse(row.encMaterial.toString('utf8')) as { ct: string };
    const flipped = Buffer.from(envelope.ct, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tampered = { ...envelope, ct: flipped.toString('base64') };
    t.rows.set(k, { ...row, encMaterial: Buffer.from(JSON.stringify(tampered)) });
    const code = await rejectionCode(t.store.get(key, () => Promise.resolve(1)));
    expect(code).toBe('SECRET_DECRYPT_FAILED');
  });

  it('fails closed when Transit is down on get: the callback never runs', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    t.transit.down = true;
    const use = vi.fn(() => Promise.resolve(1));
    const code = await rejectionCode(t.store.get(key, use));
    expect(code).toBe('KEK_UNAVAILABLE');
    expect(use).not.toHaveBeenCalled();
  });

  it('refuses a malformed scope before any read', async () => {
    const t = setup();
    const code = await rejectionCode(
      t.store.get({ ...scope(), roleName: '' }, () => Promise.resolve(1)),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });
});

describe('revoke', () => {
  it('scrubs the material at once: a later get is SM_SESSION_EXPIRED', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    expect(await t.store.revoke(key)).toBe(true);
    const row = [...t.rows.values()][0];
    expect(row).toMatchObject({ status: 'revoked' });
    expect(row?.encMaterial.length).toBe(0);
    expect(t.mirrorState.size).toBe(0);
    const code = await rejectionCode(t.store.get(key, () => Promise.resolve(1)));
    expect(code).toBe('SM_SESSION_EXPIRED');
  });

  it('is idempotent: revoking a revoked session changes nothing and still audits the request', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    await t.store.revoke(key);
    expect(await t.store.revoke(key)).toBe(false);
    expect(t.events.filter((e) => e.type === 'role_session.revoked')).toHaveLength(2);
  });

  it('audits revocation with metadata only', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    await t.store.revoke(key);
    const event = t.events.find((e) => e.type === 'role_session.revoked');
    expect(event).toMatchObject({ runId: key.runId, assetId: key.assetId, roleName: 'admin' });
    expect(JSON.stringify(t.events)).not.toContain('SUPER-SECRET');
  });

  it('revokeRun scrubs every session of the run and leaves other runs alone', async () => {
    const t = setup();
    const tenantId = newId();
    const runA = newId();
    const runB = newId();
    const assetId = newId();
    await put(t.store, { tenantId, runId: runA, assetId, roleName: 'admin' });
    await put(t.store, { tenantId, runId: runA, assetId, roleName: 'viewer' });
    await put(t.store, { tenantId, runId: runB, assetId, roleName: 'admin' });
    expect(await t.store.revokeRun(tenantId, runA)).toBe(2);
    const otherRun = await t.store.get({ tenantId, runId: runB, assetId, roleName: 'admin' }, (m) =>
      Promise.resolve(m.toString('utf8')),
    );
    expect(otherRun).toBe(PLAINTEXT);
    const revoked = await rejectionCode(
      t.store.get({ tenantId, runId: runA, assetId, roleName: 'viewer' }, () => Promise.resolve(1)),
    );
    expect(revoked).toBe('SM_SESSION_EXPIRED');
  });

  it('revokeRun refuses a malformed tenant or run id', async () => {
    const t = setup();
    await expect(t.store.revokeRun('nope', newId())).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('expire', () => {
  it('marks one session expired and scrubs it', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    expect(await t.store.expire(key)).toBe(true);
    expect([...t.rows.values()][0]).toMatchObject({ status: 'expired' });
    expect(await t.store.expire(key)).toBe(false);
  });
});

describe('observability', () => {
  it('reports each failed operation once, by its bounded name', async () => {
    const t = setup();
    t.transit.down = true;
    await rejectionCode(put(t.store, scope()));
    expect(t.ops).toEqual(['put']);
  });

  it('sets the live session count of the tenant after each change', async () => {
    const t = setup();
    const key = scope();
    await put(t.store, key);
    expect(t.active.get(key.tenantId)).toBe(1);
    await put(t.store, { ...key, roleName: 'viewer' });
    expect(t.active.get(key.tenantId)).toBe(2);
    await t.store.revoke(key);
    expect(t.active.get(key.tenantId)).toBe(1);
    await t.store.revokeRun(key.tenantId, key.runId);
    expect(t.active.get(key.tenantId)).toBe(0);
  });
});
