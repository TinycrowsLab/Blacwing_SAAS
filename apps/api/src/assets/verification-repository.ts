import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  assets,
  type TenantTx,
  verificationChallenges,
  type VerificationChallengeRow,
} from '@blackwing/db';
import { AppError } from '@blackwing/errors';

import type { AssetRow } from './repository.js';
import type {
  VerificationChallengeStatus,
  VerificationMethod,
  VerificationStatus,
} from '@blackwing/contracts';

/**
 * Persistence of the ownership-verification lifecycle (ASSET-003). Every method takes the transaction, so the state
 * change, its challenge and its audit event commit together (§8.8). RLS confines each query to the tenant context.
 */

/** The asset's verification columns. `verificationStatus` is always set; the evidence columns only when verified. */
export interface AssetVerificationPatch {
  readonly verificationStatus: VerificationStatus;
  readonly verificationMethod?: VerificationMethod | null;
  readonly verifiedAt?: Date | null;
  readonly verificationExpiresAt?: Date | null;
}

export interface ChallengeInsert {
  readonly tenantId: string;
  readonly assetId: string;
  readonly method: VerificationMethod;
  readonly token: string;
  readonly expectedLocation: string | null;
  readonly expiresAt: Date;
}

export interface ChallengePatch {
  readonly method?: VerificationMethod;
  readonly token?: string;
  readonly expectedLocation?: string | null;
  readonly status?: VerificationChallengeStatus;
  readonly attempts?: number;
  readonly expiresAt?: Date;
  readonly lastCheckedAt?: Date | null;
}

export type ChallengeRow = VerificationChallengeRow;

function notWritten(what: string): AppError {
  return new AppError('INTERNAL', `${what} produced no row`);
}

export class AssetVerificationRepository {
  /**
   * The live asset, row-locked until the transaction ends: concurrent verification writes on one asset serialise
   * here. `undefined` when the row is missing, soft-deleted or another tenant's (RLS).
   */
  async lockLive(tx: TenantTx, id: string): Promise<AssetRow | undefined> {
    const rows = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
      .limit(1)
      .for('update');
    return rows[0];
  }

  /** Writes the asset's verification columns and bumps its version (the ETag changes with every state change). */
  async setAsset(tx: TenantTx, id: string, patch: AssetVerificationPatch): Promise<AssetRow> {
    const rows = await tx
      .update(assets)
      .set({
        ...patch,
        stateVersion: sql`${assets.stateVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assets.id, id))
      .returning();
    const row = rows[0];
    if (row === undefined) throw notWritten('asset verification update');
    return row;
  }

  /** The asset's open challenge (at most one), row-locked. */
  async pendingChallenge(tx: TenantTx, assetId: string): Promise<ChallengeRow | undefined> {
    const rows = await tx
      .select()
      .from(verificationChallenges)
      .where(
        and(
          eq(verificationChallenges.assetId, assetId),
          eq(verificationChallenges.status, 'pending'),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0];
  }

  /** The asset's newest challenge in any state, or `undefined` when none was ever issued. */
  async latestChallenge(tx: TenantTx, assetId: string): Promise<ChallengeRow | undefined> {
    const rows = await tx
      .select()
      .from(verificationChallenges)
      .where(eq(verificationChallenges.assetId, assetId))
      .orderBy(desc(verificationChallenges.createdAt))
      .limit(1);
    return rows[0];
  }

  async insertChallenge(tx: TenantTx, values: ChallengeInsert): Promise<ChallengeRow> {
    const rows = await tx.insert(verificationChallenges).values(values).returning();
    const row = rows[0];
    if (row === undefined) throw notWritten('verification challenge insert');
    return row;
  }

  async updateChallenge(tx: TenantTx, id: string, patch: ChallengePatch): Promise<ChallengeRow> {
    const rows = await tx
      .update(verificationChallenges)
      .set(patch)
      .where(eq(verificationChallenges.id, id))
      .returning();
    const row = rows[0];
    if (row === undefined) throw notWritten('verification challenge update');
    return row;
  }
}
