// Server-held sessions (IAM-002, #334). The browser only ever holds a sealed opaque session id; the
// access, refresh and ID tokens live in Valkey under that id, sealed again with the session key
// (AAD = the id, so a record cannot be moved to another key). A record that cannot be opened is
// treated as absent. Valkey being unreachable is an outage (`SessionStoreUnavailableError`), never a
// silent "logged out" and never a reason to serve a request unauthenticated-but-allowed.

import { Redis } from 'ioredis';
import { z } from 'zod';

import { open, seal } from './seal.js';

const KEY_PREFIX = 'bw:web:sess:';
const LOCK_PREFIX = 'bw:web:sess-lock:';
const PURPOSE_PREFIX = 'session:';
const CONNECT_TIMEOUT_MS = 2000;

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
  /** Epoch ms at which the access token expires. */
  accessExpiresAt: z.number(),
  /** Per-session CSRF secret handed to the page by `/api/auth/session`; survives refreshes. */
  csrf: z.string().min(1),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

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
  /** Deletes `key` only when it still holds `token` (a lock must not release another owner's lock). */
  delIfEquals(key: string, token: string): Promise<unknown>;
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
    delIfEquals: (key, token) => redis.eval(RELEASE_SCRIPT, 1, key, token),
  };
}

/**
 * Connects lazily on first use and fails commands fast while Valkey is down (no offline queue), so a
 * dead Valkey becomes a 503 instead of a hung request.
 */
export function createValkey(url: string): ValkeyLike {
  let client: ValkeyLike | undefined;
  const get = (): ValkeyLike => {
    if (client !== undefined) return client;
    const redis = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });
    // Connection errors surface through the failing command; an unhandled 'error' event would crash.
    redis.on('error', () => undefined);
    client = adaptRedis(redis);
    return client;
  };
  return {
    get: (key) => get().get(key),
    setPx: (key, value, ms, mode) => get().setPx(key, value, ms, mode),
    del: (key) => get().del(key),
    delIfEquals: (key, token) => get().delIfEquals(key, token),
  };
}

export interface SessionStore {
  create(sid: string, record: SessionRecord, ttlMs: number): Promise<void>;
  get(sid: string): Promise<SessionRecord | null>;
  /** Replaces the record only while the session still exists (a logout wins over a late refresh). */
  replace(sid: string, record: SessionRecord, ttlMs: number): Promise<boolean>;
  delete(sid: string): Promise<void>;
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

  return {
    async create(sid, record, ttlMs) {
      await guard(valkey.setPx(KEY_PREFIX + sid, sealRecord(sid, record, ttlMs), ttlMs, 'NX'));
    },
    async get(sid) {
      const stored = await guard(valkey.get(KEY_PREFIX + sid));
      if (stored === null) return null;
      const parsed = sessionRecordSchema.safeParse(open(keys, PURPOSE_PREFIX + sid, stored, now()));
      return parsed.success ? parsed.data : null;
    },
    async replace(sid, record, ttlMs) {
      const result = await guard(
        valkey.setPx(KEY_PREFIX + sid, sealRecord(sid, record, ttlMs), ttlMs, 'XX'),
      );
      return result === 'OK';
    },
    async delete(sid) {
      await guard(valkey.del(KEY_PREFIX + sid));
    },
    async tryLock(sid, token, ttlMs) {
      return (await guard(valkey.setPx(LOCK_PREFIX + sid, token, ttlMs, 'NX'))) === 'OK';
    },
    async unlock(sid, token) {
      await guard(valkey.delIfEquals(LOCK_PREFIX + sid, token));
    },
  };
}
