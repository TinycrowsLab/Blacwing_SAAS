// Server-held platform-operator sessions (#838). The browser holds only a sealed opaque id (`__Host-bw_op_session`);
// the operator's tokens and CSRF secret live in Valkey under `op_session:<sid>`, sealed with the OPERATOR key (purpose
// `operator-session:<sid>`). A record that does not open is absent. Valkey being unreachable is an outage, never a
// silent "logged out" and never a reason to serve an unauthenticated request. The tenant store keeps its own indexes
// (IAM-008); operator sessions are kept apart so no tenant index can ever list or revoke an operator session.

import { z } from 'zod';

import { open, seal } from '../auth/seal.js';
import { SessionStoreUnavailableError, type ValkeyLike } from '../auth/session-store.js';

/** The operator sessions' Valkey layout: its own keyspace, lock keys and seal purpose (never the tenant's). */
export const OPERATOR_SESSION_LAYOUT = Object.freeze({
  keyPrefix: 'op_session:',
  lockPrefix: 'op_session-lock:',
  purposePrefix: 'operator-session:',
});

/** The record the operator BFF keeps in Valkey: identity and the second-factor proof, never shown to the browser. */
const operatorSessionRecordSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  name: z.string(),
  roles: z.array(z.string().min(1)),
  acr: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  /** Epoch ms at which the access token expires. */
  accessExpiresAt: z.number(),
  /** Per-session CSRF secret handed to the page by `/operator/api/auth/session`; survives refreshes. */
  csrf: z.string().min(1),
});
export type OperatorSessionRecord = z.infer<typeof operatorSessionRecordSchema>;

/** The shape check the store runs on every read: a record that does not parse is treated as absent. */
function parseOperatorRecord(raw: unknown): OperatorSessionRecord | null {
  const parsed = operatorSessionRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface OperatorSessionStore {
  create(sid: string, record: OperatorSessionRecord, ttlMs: number): Promise<void>;
  get(sid: string): Promise<OperatorSessionRecord | null>;
  /** Replaces the record only while the session still exists (a logout wins over a late refresh). */
  replace(sid: string, record: OperatorSessionRecord, ttlMs: number): Promise<boolean>;
  delete(sid: string): Promise<void>;
  /** Single-flight refresh lock: `true` when this caller now owns it, `false` when another holds it. */
  tryLock(sid: string, token: string, ttlMs: number): Promise<boolean>;
  unlock(sid: string, token: string): Promise<void>;
}

export function createOperatorSessionStore(
  valkey: ValkeyLike,
  keys: readonly [Buffer, ...Buffer[]],
  now: () => number,
): OperatorSessionStore {
  async function guard<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch {
      throw new SessionStoreUnavailableError();
    }
  }
  const sealRecord = (sid: string, record: OperatorSessionRecord, ttlMs: number): string =>
    seal(keys[0], OPERATOR_SESSION_LAYOUT.purposePrefix + sid, record, ttlMs, now());
  return {
    async create(sid, record, ttlMs) {
      await guard(
        valkey.setPx(
          OPERATOR_SESSION_LAYOUT.keyPrefix + sid,
          sealRecord(sid, record, ttlMs),
          ttlMs,
          'NX',
        ),
      );
    },
    async get(sid) {
      const stored = await guard(valkey.get(OPERATOR_SESSION_LAYOUT.keyPrefix + sid));
      if (stored === null) return null;
      return parseOperatorRecord(
        open(keys, OPERATOR_SESSION_LAYOUT.purposePrefix + sid, stored, now()),
      );
    },
    async replace(sid, record, ttlMs) {
      const result = await guard(
        valkey.setPx(
          OPERATOR_SESSION_LAYOUT.keyPrefix + sid,
          sealRecord(sid, record, ttlMs),
          ttlMs,
          'XX',
        ),
      );
      return result === 'OK';
    },
    async delete(sid) {
      await guard(valkey.del(OPERATOR_SESSION_LAYOUT.keyPrefix + sid));
    },
    async tryLock(sid, token, ttlMs) {
      return (
        (await guard(
          valkey.setPx(OPERATOR_SESSION_LAYOUT.lockPrefix + sid, token, ttlMs, 'NX'),
        )) === 'OK'
      );
    },
    async unlock(sid, token) {
      await guard(valkey.delIfEquals(OPERATOR_SESSION_LAYOUT.lockPrefix + sid, token));
    },
  };
}
