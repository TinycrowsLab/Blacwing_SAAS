// Encrypted per-role session persistence (SESSION-004, CONTEXT_PACK §7, §8.1, §8.6, §8.7). The store
// (`apps/session-manager`) encrypts the material before it reaches this module, so every value here is
// ciphertext or metadata. Methods take the tenant transaction as their first argument (`withTenant`): RLS
// confines every row, and a missing tenant context fails closed.
//
// A write is one statement. `upsert` replaces the row of the same `(tenant, run, asset, role)` in place
// (last writer wins, never a torn row), and `setStatus` scrubs the material in the same statement that moves
// the status, so a revoked or expired row never keeps ciphertext it can still be decrypted from.

import { and, count, eq, inArray, ne } from 'drizzle-orm';

import {
  INJECTABLE_STORED_SESSION_STATUSES,
  type StoredSessionKey,
  type StoredSessionKind,
  type StoredSessionStatus,
} from '@blackwing/contracts';
import { NotFoundError } from '@blackwing/errors';

import { toTenantIsolationError } from './rls.js';
import { roleSessions, type RoleSessionRow } from './schema/role-sessions.js';
import { type TenantTx, unwrapQueryError } from './with-tenant.js';

const FOREIGN_KEY_VIOLATION = '23503';

/** A foreign key violation is a missing run or asset in this tenant: `NotFoundError`, never which one (§8.6). */
function translate(error: unknown): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown };
  if (pgError.code === FOREIGN_KEY_VIOLATION) {
    return new NotFoundError('run or asset not found', { cause: error });
  }
  return toTenantIsolationError(pgError) ?? error;
}

/** One stored session as the store writes it. `id` is also the envelope's AAD binding, so it is set by the caller. */
export interface RoleSessionWrite {
  readonly id: string;
  readonly key: StoredSessionKey;
  readonly kind: StoredSessionKind;
  readonly encMaterial: Buffer;
  readonly encKeyRef: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

/** The statuses a session can be moved to by the store (`active` is set only by `upsert`). */
export type TerminalStoredSessionStatus = Extract<StoredSessionStatus, 'expired' | 'revoked'>;

function keyFilter(key: StoredSessionKey) {
  return and(
    eq(roleSessions.tenantId, key.tenantId),
    eq(roleSessions.runId, key.runId),
    eq(roleSessions.assetId, key.assetId),
    eq(roleSessions.roleName, key.roleName),
  );
}

/** Writes the session for `(tenant, run, asset, role)`, replacing any earlier one in a single statement. */
async function upsert(tx: TenantTx, write: RoleSessionWrite): Promise<RoleSessionRow> {
  const values = {
    id: write.id,
    tenantId: write.key.tenantId,
    runId: write.key.runId,
    assetId: write.key.assetId,
    roleName: write.key.roleName,
    kind: write.kind,
    encMaterial: write.encMaterial,
    encKeyRef: write.encKeyRef,
    expiresAt: write.expiresAt,
    status: 'active' as const,
    lastValidatedAt: write.now,
    createdAt: write.now,
    updatedAt: write.now,
  };
  let row: RoleSessionRow | undefined;
  try {
    [row] = await tx
      .insert(roleSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [
          roleSessions.tenantId,
          roleSessions.runId,
          roleSessions.assetId,
          roleSessions.roleName,
        ],
        set: {
          id: values.id,
          kind: values.kind,
          encMaterial: values.encMaterial,
          encKeyRef: values.encKeyRef,
          expiresAt: values.expiresAt,
          status: 'active',
          lastValidatedAt: values.lastValidatedAt,
          updatedAt: write.now,
        },
      })
      .returning();
  } catch (error) {
    throw translate(error);
  }
  if (row === undefined) throw new Error('role session upsert returned no row');
  return row;
}

/** The stored row for a scope, or `null` when there is none in this tenant (RLS hides other tenants). */
async function getByScope(tx: TenantTx, key: StoredSessionKey): Promise<RoleSessionRow | null> {
  const [row] = await tx.select().from(roleSessions).where(keyFilter(key)).limit(1);
  return row ?? null;
}

/**
 * Moves a session to `status` and scrubs its material in the same statement. A row already in that status is
 * left alone, so revoking twice is a no-op. Returns `true` when a row changed.
 */
async function setStatus(
  tx: TenantTx,
  key: StoredSessionKey,
  status: TerminalStoredSessionStatus,
  now: Date,
): Promise<boolean> {
  const changed = await tx
    .update(roleSessions)
    .set({
      status,
      encMaterial: Buffer.alloc(0),
      encKeyRef: '',
      lastValidatedAt: now,
      updatedAt: now,
    })
    .where(and(keyFilter(key), ne(roleSessions.status, status)))
    .returning({ id: roleSessions.id });
  return changed.length > 0;
}

/**
 * Revokes every session of a run (run end or kill): the same scrub as {@link setStatus}, for all the run's
 * roles and assets in one statement. Returns the scopes that changed, so the caller can drop their mirror keys.
 */
async function revokeRun(
  tx: TenantTx,
  tenantId: string,
  runId: string,
  now: Date,
): Promise<readonly { assetId: string; roleName: string }[]> {
  return tx
    .update(roleSessions)
    .set({
      status: 'revoked',
      encMaterial: Buffer.alloc(0),
      encKeyRef: '',
      lastValidatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(roleSessions.tenantId, tenantId),
        eq(roleSessions.runId, runId),
        ne(roleSessions.status, 'revoked'),
      ),
    )
    .returning({ assetId: roleSessions.assetId, roleName: roleSessions.roleName });
}

/** Live sessions of a tenant: the statuses injection may use (`active` and `refreshing`). */
async function countActive(tx: TenantTx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(roleSessions)
    .where(
      and(
        eq(roleSessions.tenantId, tenantId),
        inArray(roleSessions.status, [...INJECTABLE_STORED_SESSION_STATUSES]),
      ),
    );
  return row?.n ?? 0;
}

export const roleSessionRepository = Object.freeze({
  upsert,
  getByScope,
  setStatus,
  revokeRun,
  countActive,
});
