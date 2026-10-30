// Server-held sessions (IAM-002, #334). The browser only ever holds a sealed opaque session id; the
// access, refresh and ID tokens live in Valkey under that id, sealed again with the session key
// (AAD = the id, so a record cannot be moved to another key). A record that cannot be opened is
// treated as absent. Valkey being unreachable is an outage (`SessionStoreUnavailableError`), never a
// silent "logged out" and never a reason to serve a request unauthenticated-but-allowed.
//
// Revocation (#336) needs to find a user's, a tenant's or an IdP session's BFF sessions without a full
// scan, so every session is also listed in reverse-index sets (`user`, `tenant`, and `idp` for the
// Keycloak `sid`). Index sets live for the longest session lifetime and are refreshed on every add;
// their members are pruned when a record is revoked or found missing. The record itself is always the
// authority: a stale index member never keeps a session alive.

import { Redis } from 'ioredis';
import { z } from 'zod';

import { open, seal } from './seal.js';

const KEY_PREFIX = 'bw:web:sess:';
const INDEX_PREFIX = 'bw:web:sess-idx:';
const LOCK_PREFIX = 'bw:web:sess-lock:';
const CLAIM_PREFIX = 'bw:web:claim:';
const PURPOSE_PREFIX = 'session:';
const CONNECT_TIMEOUT_MS = 2000;
/** The absolute cap on any session lifetime; index sets are kept at least this long. */
export const MAX_SESSION_TTL_MS = 43_200_000;
/** Members visited per `SSCAN` page during a revocation: bounded work per round trip. */
const REVOKE_BATCH = 100;

const sessionRecordSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  name: z.string(),
  tenantId: z.string().min(1),
  tenantSlug: z.string().min(1),
  roles: z.array(z.string().min(1)),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  /** Keycloak's session id (`sid` claim of the ID token): what back-channel logout names. */
  idpSid: z.string().min(1).optional(),
  /** Epoch ms at which the access token expires. */
  accessExpiresAt: z.number(),
  /** Per-session CSRF secret handed to the page by `/api/auth/session`; survives refreshes. */
  csrf: z.string().min(1),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

/** A reverse index of sessions: by user, by tenant, or by the Keycloak session they belong to. */
export type SessionIndex =
  | { readonly kind: 'user'; readonly sub: string }
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | { readonly kind: 'idp'; readonly sid: string };

/** Valkey could not be reached or answered an error. */
export class SessionStoreUnavailableError extends Error {
  override readonly name = 'SessionStoreUnavailableError';
  constructor() {
    super('The session store is unavailable');
  }
}

/** The slice of a Redis/Valkey client the store uses; tests pass a fake. */
export interface ValkeyLike {
  get(key: string): Promise<string | null>;
  /** `SET key value PX ms [NX|XX]`; `null` when the NX/XX condition failed. */
  setPx(key: string, value: string, ms: number, mode?: 'NX' | 'XX'): Promise<'OK' | null>;
  del(key: string): Promise<unknown>;
  /** Deletes keys in one command. */
  delMany(keys: readonly string[]): Promise<unknown>;
  /** Deletes `key` only when it still holds `token` (a lock must not release another owner's lock). */
  delIfEquals(key: string, token: string): Promise<unknown>;
  mget(keys: readonly string[]): Promise<(string | null)[]>;
  /** `SADD`. */
  sadd(key: string, member: string): Promise<unknown>;
  /** `SREM` of several members in one command. */
  srem(key: string, members: readonly string[]): Promise<unknown>;
  /** One bounded page of a set (`SSCAN`); the returned cursor is `'0'` when the walk is complete. */
  sscan(key: string, cursor: string, count: number): Promise<[string, string[]]>;
  /** `PEXPIRE`. */
  pexpire(key: string, ms: number): Promise<unknown>;
}

const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** Adapts an ioredis client to {@link ValkeyLike}. */
export function adaptRedis(redis: Redis): ValkeyLike {
  return {
    get: (key) => redis.get(key),
    setPx: (key, value, ms, mode) =>
      mode === undefined
        ? redis.set(key, value, 'PX', ms)
        : mode === 'NX'
          ? redis.set(key, value, 'PX', ms, 'NX')
          : redis.set(key, value, 'PX', ms, 'XX'),
    del: (key) => redis.del(key),
    delMany: (keys) => redis.del(...keys),
    delIfEquals: (key, token) => redis.eval(RELEASE_SCRIPT, 1, key, token),
    mget: (keys) => redis.mget(...keys),
    sadd: (key, member) => redis.sadd(key, member),
    srem: (key, members) => redis.srem(key, ...members),
    sscan: (key, cursor, count) => redis.sscan(key, cursor, 'COUNT', count),
    pexpire: (key, ms) => redis.pexpire(key, ms),
  };
}

/**
 * Connects lazily on first use and fails commands fast while Valkey is down (no offline queue), so a
 * dead Valkey becomes a 503 instead of a hung request.
 */
export function createValkey(url: string): ValkeyLike {
  let redis: Redis | undefined;
  let client: ValkeyLike | undefined;
  // Without an offline queue a command sent before the socket is up is rejected, so wait (bounded)
  // for the connection to become ready instead of failing the first request after startup.
  const get = async (): Promise<ValkeyLike> => {
    if (redis === undefined || client === undefined) {
      redis = new Redis(url, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: CONNECT_TIMEOUT_MS,
      });
      // Connection errors surface through the failing command; an unhandled 'error' event would crash.
      redis.on('error', () => undefined);
      client = adaptRedis(redis);
    }
    const connection = redis;
    if (connection.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('valkey connect timeout'));
        }, CONNECT_TIMEOUT_MS);
        const onReady = (): void => {
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error('valkey connection closed'));
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          connection.off('ready', onReady);
          connection.off('close', onClose);
        };
        connection.once('ready', onReady);
        connection.once('close', onClose);
      });
    }
    return client;
  };
  return {
    get: async (key) => (await get()).get(key),
    setPx: async (key, value, ms, mode) => (await get()).setPx(key, value, ms, mode),
    del: async (key) => (await get()).del(key),
    delMany: async (keys) => (await get()).delMany(keys),
    delIfEquals: async (key, token) => (await get()).delIfEquals(key, token),
    mget: async (keys) => (await get()).mget(keys),
    sadd: async (key, member) => (await get()).sadd(key, member),
    srem: async (key, members) => (await get()).srem(key, members),
    sscan: async (key, cursor, count) => (await get()).sscan(key, cursor, count),
    pexpire: async (key, ms) => (await get()).pexpire(key, ms),
  };
}

export interface SessionStore {
  /** Creates the session and indexes it. Indexes are written first, so a failure leaves no session behind. */
  create(sid: string, record: SessionRecord, ttlMs: number): Promise<void>;
  get(sid: string): Promise<SessionRecord | null>;
  /** Replaces the record only while the session still exists (a logout wins over a late refresh). */
  replace(sid: string, record: SessionRecord, ttlMs: number): Promise<boolean>;
  /** Ends one session and removes it from its indexes. */
  delete(sid: string): Promise<void>;
  /**
   * Ends every session listed in `index` whose record satisfies `match`, a bounded batch at a time.
   * Returns the records that were ended. Index members whose record is gone are pruned along the way.
   */
  revokeWhere(
    index: SessionIndex,
    match: (record: SessionRecord) => boolean,
  ): Promise<SessionRecord[]>;
  /** Claims a one-time token id for `ttlMs`: `true` the first time, `false` on any replay. */
  claimOnce(id: string, ttlMs: number): Promise<boolean>;
  /** Single-flight refresh lock: `true` when this caller now owns it, `false` when another holds it. */
  tryLock(sid: string, token: string, ttlMs: number): Promise<boolean>;
  unlock(sid: string, token: string): Promise<void>;
}

export function createSessionStore(
  valkey: ValkeyLike,
  keys: readonly [Buffer, ...Buffer[]],
  now: () => number,
): SessionStore {
  async function guard<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch {
      throw new SessionStoreUnavailableError();
    }
  }
  const sealRecord = (sid: string, record: SessionRecord, ttlMs: number): string =>
    seal(keys[0], PURPOSE_PREFIX + sid, record, ttlMs, now());
  const decode = (sid: string, stored: string | null): SessionRecord | null => {
    if (stored === null) return null;
    const parsed = sessionRecordSchema.safeParse(open(keys, PURPOSE_PREFIX + sid, stored, now()));
    return parsed.success ? parsed.data : null;
  };

  const indexKey = (index: SessionIndex): string =>
    INDEX_PREFIX +
    (index.kind === 'user'
      ? `user:${index.sub}`
      : index.kind === 'tenant'
        ? `tenant:${index.tenantId}`
        : `idp:${index.sid}`);
  const indexKeysOf = (record: SessionRecord): string[] => [
    indexKey({ kind: 'user', sub: record.sub }),
    indexKey({ kind: 'tenant', tenantId: record.tenantId }),
    ...(record.idpSid === undefined ? [] : [indexKey({ kind: 'idp', sid: record.idpSid })]),
  ];

  /** Lists the session under each of its indexes (the TTL is refreshed on every add). */
  async function indexAdd(sid: string, keysToIndex: readonly string[]): Promise<void> {
    await Promise.all(
      keysToIndex.map(async (key) => {
        await valkey.sadd(key, sid);
        await valkey.pexpire(key, MAX_SESSION_TTL_MS);
      }),
    );
  }

  /** Groups members by key so each index is pruned with one command. */
  function groupByKey(entries: readonly [string, string][]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const [key, sid] of entries) {
      const members = grouped.get(key);
      if (members === undefined) grouped.set(key, [sid]);
      else members.push(sid);
    }
    return grouped;
  }

  return {
    async create(sid, record, ttlMs) {
      await guard(indexAdd(sid, indexKeysOf(record)));
      await guard(valkey.setPx(KEY_PREFIX + sid, sealRecord(sid, record, ttlMs), ttlMs, 'NX'));
    },
    async get(sid) {
      return decode(sid, await guard(valkey.get(KEY_PREFIX + sid)));
    },
    async replace(sid, record, ttlMs) {
      const previous = decode(sid, await guard(valkey.get(KEY_PREFIX + sid)));
      const result = await guard(
        valkey.setPx(KEY_PREFIX + sid, sealRecord(sid, record, ttlMs), ttlMs, 'XX'),
      );
      if (result !== 'OK') return false;
      // A refresh may change the tenant the ID token names: move the session to the right indexes.
      const next = indexKeysOf(record);
      await guard(indexAdd(sid, next));
      const stale = previous === null ? [] : indexKeysOf(previous).filter((k) => !next.includes(k));
      await Promise.all(stale.map((key) => guard(valkey.srem(key, [sid]))));
      return true;
    },
    async delete(sid) {
      const record = decode(sid, await guard(valkey.get(KEY_PREFIX + sid)));
      await guard(valkey.del(KEY_PREFIX + sid));
      if (record === null) return;
      await Promise.all(indexKeysOf(record).map((key) => guard(valkey.srem(key, [sid]))));
    },
    async revokeWhere(index, match) {
      const key = indexKey(index);
      const revoked: SessionRecord[] = [];
      let cursor = '0';
      do {
        const [next, sids] = await guard(valkey.sscan(key, cursor, REVOKE_BATCH));
        cursor = next;
        if (sids.length === 0) continue;
        const stored = await guard(valkey.mget(sids.map((sid) => KEY_PREFIX + sid)));
        const doomed: string[] = [];
        const pruned: [string, string][] = [];
        sids.forEach((sid, i) => {
          const record = decode(sid, stored[i] ?? null);
          if (record === null) {
            pruned.push([key, sid]);
            return;
          }
          if (!match(record)) return;
          doomed.push(sid);
          revoked.push(record);
          for (const other of indexKeysOf(record)) pruned.push([other, sid]);
        });
        if (doomed.length > 0) {
          await guard(valkey.delMany(doomed.map((sid) => KEY_PREFIX + sid)));
        }
        for (const [member, sids] of groupByKey(pruned)) {
          await guard(valkey.srem(member, sids));
        }
      } while (cursor !== '0');
      return revoked;
    },
    async claimOnce(id, ttlMs) {
      return (await guard(valkey.setPx(CLAIM_PREFIX + id, '1', ttlMs, 'NX'))) === 'OK';
    },
    async tryLock(sid, token, ttlMs) {
      return (await guard(valkey.setPx(LOCK_PREFIX + sid, token, ttlMs, 'NX'))) === 'OK';
    },
    async unlock(sid, token) {
      await guard(valkey.delIfEquals(LOCK_PREFIX + sid, token));
    },
  };
}
