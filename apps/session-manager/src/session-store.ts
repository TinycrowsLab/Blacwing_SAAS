// Encrypted per-role session store (SESSION-004, CONTEXT_PACK §3.1, §8.1, §8.6, §8.7). It persists the live
// session of one role (cookies, tokens, headers) for one asset in one run. The Postgres row is the source of
// truth: the material is envelope-encrypted before it reaches it, and only the ciphertext is stored. The Valkey
// mirror holds metadata and a pointer, never material, and is reconciled from Postgres on every read.
//
// Plaintext exists only inside `get`, for the duration of the caller's `use` callback, and is zeroed afterwards.
// Every failure to read a usable session is `SM_SESSION_EXPIRED` (fail closed, and one answer for every reason,
// so the caller cannot tell a revoked session from an absent one). Encryption or decryption errors (for example
// OpenBao Transit being down) surface as their own error and never fall back to plaintext.

import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import {
  INJECTABLE_STORED_SESSION_STATUSES,
  type StoredSessionKey,
  type StoredSessionKind,
  type StoredSessionStatus,
  storedSessionKeySchema,
  storedSessionKindSchema,
  STORED_SESSION_MAX_MATERIAL_BYTES,
  uuidV7Schema,
} from '@blackwing/contracts';
import {
  type Database,
  roleSessionRepository,
  type RoleSessionWrite,
  withTenant,
} from '@blackwing/db';
import { AppError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type Envelope, type EnvelopeCrypto, EnvelopeError } from '@blackwing/secrets';

import { SmSessionExpiredError } from './errors.js';

import type { Logger } from '@blackwing/logger';
import type { Redis } from 'ioredis';

/** AAD purpose of every stored session: a ciphertext cannot be replayed as another kind of secret. */
const SESSION_PURPOSE = 'role_session';
/** Clock skew margin: a session this close to expiry is treated as expired (SESSION-010 refreshes it). */
export const EXPIRY_SKEW_MS = 5_000;
const MS_PER_SECOND = 1000;
/** Valkey key prefix of the mirror (`sm:sess:<tenant>:<run>:<asset>:<role>`). */
const MIRROR_KEY_PREFIX = 'sm:sess:';

/** One stored row as the store sees it. `material` is the envelope JSON, never plaintext. */
export interface StoredSessionRecord {
  readonly id: string;
  readonly status: StoredSessionStatus;
  readonly expiresAt: Date;
  readonly encMaterial: Buffer;
}

/** The persistence port. `createPgSessionPort` is the Postgres implementation; tests use an in-memory one. */
export interface SessionPort {
  upsert(write: RoleSessionWrite): Promise<void>;
  find(key: StoredSessionKey): Promise<StoredSessionRecord | null>;
  setStatus(key: StoredSessionKey, status: 'expired' | 'revoked', now: Date): Promise<boolean>;
  revokeRun(
    tenantId: string,
    runId: string,
    now: Date,
  ): Promise<readonly { assetId: string; roleName: string }[]>;
  countActive(tenantId: string): Promise<number>;
}

/** Valkey mirror: metadata and a pointer only. The store never writes material here. */
export interface SessionMirror {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

type RoleSessionAuditType = 'role_session.stored' | 'role_session.revoked';

/** Audit event, metadata only: never the material, never a cookie or token value. */
export interface RoleSessionAuditEvent {
  readonly type: RoleSessionAuditType;
  readonly tenantId: string;
  readonly runId: string;
  readonly assetId: string;
  readonly roleName: string;
  readonly occurredAt: string;
  readonly kind?: StoredSessionKind;
  readonly expiresAt?: string;
}

interface RoleSessionAuditEmitter {
  emit(event: RoleSessionAuditEvent): Promise<void>;
}

export interface SessionStoreDeps {
  readonly sessions: SessionPort;
  readonly envelope: EnvelopeCrypto;
  readonly mirror: SessionMirror;
  readonly audit: RoleSessionAuditEmitter;
  readonly logger: Logger;
  readonly tracer: Tracer;
  /** `SM_SESSION_TTL_SECONDS`: the validity window of a stored session. */
  readonly ttlSeconds: number;
  /** Called once per failed store operation, with the operation name (a bounded label). */
  readonly onError?: (op: SessionStoreOp) => void;
  /** Called after each change with the tenant's live session count (`sm_sessions_active{tenant}`). */
  readonly onActiveCount?: (tenantId: string, count: number) => void;
  readonly clock?: () => Date;
}

export type SessionStoreOp = 'put' | 'get' | 'revoke' | 'expire';

export interface PutSessionInput {
  readonly kind: StoredSessionKind;
  readonly material: Uint8Array;
  /** The run or SA window end. `expires_at` is never later than this (S8.1). */
  readonly runWindowEndsAt: Date;
}

export interface PutSessionResult {
  readonly id: string;
  readonly expiresAt: Date;
}

export interface SessionStore {
  /** Stores the session of a scope, replacing any earlier one. Fails closed when encryption or storage fails. */
  put(key: StoredSessionKey, input: PutSessionInput): Promise<PutSessionResult>;
  /**
   * Decrypts the live session and passes its bytes to `use`. The bytes are zeroed when `use` settles. Throws
   * `SM_SESSION_EXPIRED` for anything not injectable (absent, revoked, expired, or within the skew margin).
   */
  get<T>(key: StoredSessionKey, use: (material: Buffer) => Promise<T>): Promise<T>;
  /** Scrubs the material of one session at once. Idempotent: revoking a revoked session changes nothing. */
  revoke(key: StoredSessionKey): Promise<boolean>;
  /** Revokes every session of a run (run end or kill). Returns how many changed. */
  revokeRun(tenantId: string, runId: string): Promise<number>;
  /** Marks one session expired and scrubs its material. Used by the TTL sweep and by `get` past expiry. */
  expire(key: StoredSessionKey): Promise<boolean>;
}

const runScopeSchema = z.object({ tenantId: uuidV7Schema, runId: uuidV7Schema });

/** The envelope as stored: the shape `@blackwing/secrets` writes. Parsed before any KEK call. */
const storedEnvelopeSchema = z.strictObject({
  v: z.literal(1),
  alg: z.literal('AES-256-GCM'),
  kekKey: z.string().min(1),
  kekVersion: z.number().int().nonnegative(),
  wrappedDek: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ct: z.string(),
  aadHash: z.string().min(1),
});

/** Mirror key of one scope. The role name cannot contain a colon, so the key is unambiguous. */
export function mirrorKey(key: StoredSessionKey): string {
  return `${MIRROR_KEY_PREFIX}${key.tenantId}:${key.runId}:${key.assetId}:${key.roleName}`;
}

/** Postgres implementation of the port: every call runs in the tenant's transaction (RLS, fail closed). */
export function createPgSessionPort(db: Database): SessionPort {
  return {
    upsert: (write) =>
      withTenant(db, write.key.tenantId, async (tx) => {
        await roleSessionRepository.upsert(tx, write);
      }),
    find: (key) =>
      withTenant(db, key.tenantId, async (tx) => {
        const row = await roleSessionRepository.getByScope(tx, key);
        return row === null
          ? null
          : {
              id: row.id,
              status: row.status,
              expiresAt: row.expiresAt,
              encMaterial: row.encMaterial,
            };
      }),
    setStatus: (key, status, now) =>
      withTenant(db, key.tenantId, (tx) => roleSessionRepository.setStatus(tx, key, status, now)),
    revokeRun: (tenantId, runId, now) =>
      withTenant(db, tenantId, (tx) => roleSessionRepository.revokeRun(tx, tenantId, runId, now)),
    countActive: (tenantId) =>
      withTenant(db, tenantId, (tx) => roleSessionRepository.countActive(tx, tenantId)),
  };
}

/** Valkey mirror over an ioredis client (`PX` expiry, so the mirror lapses with the session). */
export function createValkeySessionMirror(client: Pick<Redis, 'set' | 'del'>): SessionMirror {
  return {
    async set(key, value, ttlMs) {
      await client.set(key, value, 'PX', ttlMs);
    },
    async del(key) {
      await client.del(key);
    },
  };
}

/** Runs one store operation in a span named `session.<op>`, recording the failure and counting it. */
async function traced<T>(
  deps: SessionStoreDeps,
  op: SessionStoreOp,
  fn: () => Promise<T>,
): Promise<T> {
  return deps.tracer.startActiveSpan(`session.${op}`, async (span) => {
    try {
      return await fn();
    } catch (error) {
      deps.onError?.(op);
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The session is absent or unusable. One error for every reason (no oracle for the caller). */
function unavailable(): SmSessionExpiredError {
  return new SmSessionExpiredError('no live session for this role; re-establish the login');
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const clock = deps.clock ?? (() => new Date());
  const { sessions, envelope, mirror, audit, logger } = deps;
  const log = logger.child({ component: 'store' });

  /** The gauge is best effort: a failed count is logged and never fails the operation it follows. */
  async function reportActive(tenantId: string) {
    if (deps.onActiveCount === undefined) return;
    try {
      deps.onActiveCount(tenantId, await sessions.countActive(tenantId));
    } catch (error) {
      log.warn({ op: 'count_active', error_code: errorCode(error) }, 'session.count_failed');
    }
  }

  /** Mirror writes are a cache: a failure is logged and the next read repairs it. */
  async function mirrorSet(key: StoredSessionKey, expiresAt: Date, id: string, now: Date) {
    const ttlMs = expiresAt.getTime() - now.getTime();
    if (ttlMs <= 0) return;
    try {
      await mirror.set(
        mirrorKey(key),
        JSON.stringify({ id, status: 'active', expiresAt: expiresAt.toISOString() }),
        ttlMs,
      );
    } catch (error) {
      log.warn({ op: 'mirror_set', error_code: errorCode(error) }, 'session.mirror_failed');
    }
  }

  async function mirrorDel(key: StoredSessionKey) {
    try {
      await mirror.del(mirrorKey(key));
    } catch (error) {
      log.warn({ op: 'mirror_del', error_code: errorCode(error) }, 'session.mirror_failed');
    }
  }

  const store: SessionStore = {
    put: (key, input) =>
      traced(deps, 'put', async () => {
        const scope = parseKey(key);
        const kind = storedSessionKindSchema.safeParse(input.kind);
        if (!kind.success) throw new ValidationError('invalid session kind');
        if (input.material.byteLength > STORED_SESSION_MAX_MATERIAL_BYTES) {
          throw new AppError('SECRET_TOO_LARGE', 'session material exceeds the size cap', {
            detail: `Session material is capped at ${String(STORED_SESSION_MAX_MATERIAL_BYTES)} bytes.`,
          });
        }
        const now = clock();
        if (input.runWindowEndsAt.getTime() <= now.getTime()) {
          throw new SmSessionExpiredError('the run window is closed; no session can be stored');
        }
        // expires_at is the TTL, capped at the run window end (S8.1).
        const ttlEnd = now.getTime() + deps.ttlSeconds * MS_PER_SECOND;
        const expiresAt = new Date(Math.min(ttlEnd, input.runWindowEndsAt.getTime()));
        const id = newId();

        // Encryption first: if Transit is down the call fails here and nothing is written (fail closed).
        const sealed: Envelope = await envelope.encryptSecret({
          tenantId: scope.tenantId,
          plaintext: input.material,
          context: { secretId: id, purpose: SESSION_PURPOSE },
        });
        await sessions.upsert({
          id,
          key: scope,
          kind: kind.data,
          encMaterial: Buffer.from(JSON.stringify(sealed), 'utf8'),
          encKeyRef: `${sealed.kekKey}@v${String(sealed.kekVersion)}`,
          expiresAt,
          now,
        });
        await mirrorSet(scope, expiresAt, id, now);
        await reportActive(scope.tenantId);
        await audit.emit({
          type: 'role_session.stored',
          tenantId: scope.tenantId,
          runId: scope.runId,
          assetId: scope.assetId,
          roleName: scope.roleName,
          kind: kind.data,
          expiresAt: expiresAt.toISOString(),
          occurredAt: now.toISOString(),
        });
        log.info({ run_id: scope.runId, role: scope.roleName, kind: kind.data }, 'session.stored');
        return { id, expiresAt };
      }),

    get: (key, use) =>
      traced(deps, 'get', async () => {
        const scope = parseKey(key);
        const now = clock();
        const row = await sessions.find(scope);
        if (row === null || !isInjectable(row.status)) throw unavailable();
        if (now.getTime() + EXPIRY_SKEW_MS >= row.expiresAt.getTime()) {
          await store.expire(scope);
          throw unavailable();
        }
        const sealed = parseEnvelope(row.encMaterial);
        // Decryption failure throws here with nothing to zero; the callback's bytes are zeroed when it settles.
        const plaintext = await envelope.decryptSecret(sealed, {
          tenantId: scope.tenantId,
          context: { secretId: row.id, purpose: SESSION_PURPOSE },
        });
        try {
          const result = await use(plaintext);
          await mirrorSet(scope, row.expiresAt, row.id, now);
          return result;
        } finally {
          plaintext.fill(0);
        }
      }),

    revoke: (key) =>
      traced(deps, 'revoke', async () => {
        const scope = parseKey(key);
        const now = clock();
        const changed = await sessions.setStatus(scope, 'revoked', now);
        await mirrorDel(scope);
        await reportActive(scope.tenantId);
        await audit.emit({
          type: 'role_session.revoked',
          tenantId: scope.tenantId,
          runId: scope.runId,
          assetId: scope.assetId,
          roleName: scope.roleName,
          occurredAt: now.toISOString(),
        });
        log.info({ run_id: scope.runId, role: scope.roleName, changed }, 'session.revoked');
        return changed;
      }),

    revokeRun: (tenantId, runId) =>
      traced(deps, 'revoke', async () => {
        const ids = runScopeSchema.safeParse({ tenantId, runId });
        if (!ids.success) throw new ValidationError('invalid run scope');
        const now = clock();
        const revoked = await sessions.revokeRun(ids.data.tenantId, ids.data.runId, now);
        for (const row of revoked) {
          await mirrorDel({ tenantId: ids.data.tenantId, runId: ids.data.runId, ...row });
          await audit.emit({
            type: 'role_session.revoked',
            tenantId: ids.data.tenantId,
            runId: ids.data.runId,
            assetId: row.assetId,
            roleName: row.roleName,
            occurredAt: now.toISOString(),
          });
        }
        await reportActive(ids.data.tenantId);
        log.info({ run_id: ids.data.runId, revoked: revoked.length }, 'session.run_revoked');
        return revoked.length;
      }),

    expire: (key) =>
      traced(deps, 'expire', async () => {
        const scope = parseKey(key);
        const changed = await sessions.setStatus(scope, 'expired', clock());
        await mirrorDel(scope);
        await reportActive(scope.tenantId);
        return changed;
      }),
  };
  return store;
}

function parseKey(key: unknown): StoredSessionKey {
  const parsed = storedSessionKeySchema.safeParse(key);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError('invalid session scope', {
      detail: `Invalid session scope: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return parsed.data;
}

function parseEnvelope(material: Buffer): Envelope {
  let json: unknown;
  try {
    json = JSON.parse(material.toString('utf8'));
  } catch (error) {
    throw new EnvelopeError('ENVELOPE_INVALID', 'stored session envelope is not JSON', error);
  }
  const parsed = storedEnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new EnvelopeError('ENVELOPE_INVALID', 'malformed stored envelope');
  return parsed.data;
}

function isInjectable(status: StoredSessionStatus): boolean {
  return (INJECTABLE_STORED_SESSION_STATUSES as readonly string[]).includes(status);
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'UNKNOWN';
}
