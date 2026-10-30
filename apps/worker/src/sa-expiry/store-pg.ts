import { and, eq, sql } from 'drizzle-orm';

import { createAuditEmitter } from '@blackwing/audit';
import {
  standingAuthorisations,
  toAuditSqlTx,
  withTenant,
  type Database,
  type TenantTx,
} from '@blackwing/db';
import { transitionSa, type SaState } from '@blackwing/domain';
import { AppError } from '@blackwing/errors';

import type { SaExpiryStore } from './ports.js';
import type { SaExpiryOutcome, SaExpiryRef } from './types.js';

/** The acting principal of the expiry workflow (domain shape): there is no user behind it. */
const EXPIRY_ACTOR = { kind: 'system', id: 'sa-expiry' } as const;
/** The same principal in the audit event shape. */
const EXPIRY_AUDIT_ACTOR = { type: 'system', id: 'sa-expiry' } as const;

const audit = createAuditEmitter();

async function checkInTx(tx: TenantTx, ref: SaExpiryRef): Promise<SaExpiryOutcome> {
  // The database clock decides expiry (clock skew between pods and the DB cannot expire early or late).
  const clock = await tx.execute<{ now: Date }>(sql`SELECT now() AS now`);
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new AppError('INTERNAL', 'database clock returned no row');

  const [row] = await tx
    .select()
    .from(standingAuthorisations)
    .where(
      and(
        eq(standingAuthorisations.tenantId, ref.tenantId),
        eq(standingAuthorisations.id, ref.saId),
      ),
    )
    .limit(1)
    .for('update');
  if (row?.status !== 'active') return { kind: 'terminal' };

  if (row.expiresAt.getTime() > now.getTime()) {
    const remainingMs = row.expiresAt.getTime() - now.getTime();
    return { kind: 'not_due', remainingMs: Math.max(1, remainingMs) };
  }

  const state: SaState = {
    status: row.status,
    version: row.version,
    requesterId: row.requesterId,
    approverId: row.approverId,
    expiresAt: row.expiresAt,
    revocationReason: row.revocationReason,
  };
  const { next } = transitionSa(state, 'expire', { actor: EXPIRY_ACTOR, now });

  const [updated] = await tx
    .update(standingAuthorisations)
    .set({
      status: next.status,
      version: sql`${standingAuthorisations.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(standingAuthorisations.tenantId, ref.tenantId),
        eq(standingAuthorisations.id, row.id),
        eq(standingAuthorisations.version, row.version),
      ),
    )
    .returning();
  if (updated === undefined)
    throw new AppError('INTERNAL', 'standing authorisation expiry lost its row lock');

  await audit.emitAuditInTx(toAuditSqlTx(tx), {
    tenantId: ref.tenantId,
    action: 'authz.sa.expired',
    actor: EXPIRY_AUDIT_ACTOR,
    target: { type: 'standing_authorisation', id: updated.id, publicId: updated.publicId },
    outcome: 'success',
    metadata: { from: 'active', to: 'expired' },
  });
  return { kind: 'expired' };
}

/**
 * The Postgres store of the expiry check, on the app-role connection: one `withTenant` transaction per check.
 * The row is locked `FOR UPDATE`, so a concurrent revoke or a second expiry check serialises behind it; the
 * second one then finds the SA no longer `active` and reports `terminal` (idempotent).
 */
export function createPgSaExpiryStore(db: Database): SaExpiryStore {
  return {
    checkAndExpire(ref) {
      return withTenant(db, ref.tenantId, (tx) => checkInTx(tx, ref));
    },
  };
}
