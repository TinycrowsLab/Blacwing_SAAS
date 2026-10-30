import { and, eq, isNull, sql } from 'drizzle-orm';

import { createAuditEmitter } from '@blackwing/audit';
import {
  assets,
  type Database,
  verificationChallenges,
  withTenant,
  type TenantTx,
} from '@blackwing/db';
import {
  addDays,
  decideAfterProbe,
  DEFAULT_VERIFICATION_POLICY,
  isChallengeExpired,
  transitionVerification,
  type VerificationPolicy,
} from '@blackwing/domain';
import { AppError } from '@blackwing/errors';

import { toAuditSqlTx } from '../../outbox/audit-tx.js';

import type { DnsChallenge, DnsProbeOutcome, VerificationDnsStore } from './activities.js';

/**
 * Postgres adapter of the DNS probe's store. It runs the same transitions the API's verification service runs for a
 * probe answer (`decideAfterProbe`, `transitionVerification`), inside one tenant transaction per answer. The
 * challenge and asset rows are locked for the transaction, so a concurrent check serialises here.
 */

const audit = createAuditEmitter();

/** The acting principal of a worker-run probe: there is no user behind it. */
const PROBE_ACTOR = { type: 'system', id: 'verification-dns' } as const;

async function applyInTx(
  tx: TenantTx,
  input: {
    readonly tenantId: string;
    readonly challengeId: string;
    readonly matched: boolean;
    readonly at: Date;
  },
  policy: VerificationPolicy,
): Promise<DnsProbeOutcome> {
  const [open] = await tx
    .select()
    .from(verificationChallenges)
    .where(
      and(
        eq(verificationChallenges.id, input.challengeId),
        eq(verificationChallenges.status, 'pending'),
      ),
    )
    .limit(1)
    .for('update');
  if (open === undefined) return 'ignored';

  const [asset] = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.id, open.assetId), isNull(assets.deletedAt)))
    .limit(1)
    .for('update');
  if (asset?.verificationStatus !== 'pending') return 'ignored';
  if (isChallengeExpired(open.expiresAt, input.at)) return 'ignored';

  const attempts = open.attempts + 1;
  const decision = decideAfterProbe(input.matched, attempts, policy.maxCheckAttempts);
  if (decision === 'retry') {
    await tx
      .update(verificationChallenges)
      .set({ attempts, lastCheckedAt: input.at })
      .where(eq(verificationChallenges.id, open.id));
    return 'retry';
  }

  if (decision === 'passed') {
    const next = transitionVerification(asset.verificationStatus, 'pass');
    await tx
      .update(verificationChallenges)
      .set({ status: 'passed', attempts, lastCheckedAt: input.at })
      .where(eq(verificationChallenges.id, open.id));
    const [verified] = await tx
      .update(assets)
      .set({
        verificationStatus: next,
        verificationMethod: open.method,
        verifiedAt: input.at,
        verificationExpiresAt: addDays(input.at, policy.verificationTtlDays),
        stateVersion: sql`${assets.stateVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assets.id, asset.id))
      .returning();
    if (verified === undefined)
      throw new AppError('INTERNAL', 'verified asset update produced no row');
    await audit.emitAuditInTx(toAuditSqlTx(tx), {
      tenantId: input.tenantId,
      action: 'asset.verification_passed',
      actor: PROBE_ACTOR,
      target: { type: 'asset', id: verified.id, publicId: verified.publicId },
      outcome: 'success',
      metadata: { method: open.method, attempts },
    });
    return 'passed';
  }

  // The attempt budget is spent: the challenge fails and the asset goes back to unverified.
  const next = transitionVerification(asset.verificationStatus, 'fail');
  await tx
    .update(verificationChallenges)
    .set({ status: 'failed', attempts, lastCheckedAt: input.at })
    .where(eq(verificationChallenges.id, open.id));
  const [unverified] = await tx
    .update(assets)
    .set({
      verificationStatus: next,
      stateVersion: sql`${assets.stateVersion} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, asset.id))
    .returning();
  if (unverified === undefined)
    throw new AppError('INTERNAL', 'unverified asset update produced no row');
  await audit.emitAuditInTx(toAuditSqlTx(tx), {
    tenantId: input.tenantId,
    action: 'asset.verification_failed',
    actor: PROBE_ACTOR,
    target: { type: 'asset', id: unverified.id, publicId: unverified.publicId },
    outcome: 'success',
    metadata: { method: open.method, reason: 'attempts_exhausted', attempts },
  });
  return 'failed';
}

/** The Postgres store of the DNS probe, on the app-role connection: every call runs under `withTenant`. */
export function createPgVerificationDnsStore(
  db: Database,
  policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY,
): VerificationDnsStore {
  return {
    async load(tenantId, challengeId): Promise<DnsChallenge | undefined> {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(verificationChallenges)
          .where(eq(verificationChallenges.id, challengeId))
          .limit(1);
        if (row === undefined) return undefined;
        return {
          challengeId: row.id,
          assetId: row.assetId,
          method: row.method,
          token: row.token,
          expectedLocation: row.expectedLocation,
          status: row.status,
          expiresAt: row.expiresAt,
        };
      });
    },

    async apply(input): Promise<DnsProbeOutcome> {
      return withTenant(db, input.tenantId, (tx) => applyInTx(tx, input, policy));
    },
  };
}
