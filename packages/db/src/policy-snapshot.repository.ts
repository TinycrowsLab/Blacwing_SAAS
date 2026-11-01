// Signed policy snapshot persistence (POLICY-007, CONTEXT_PACK §7, §8.6, §8.8, §8.9). The row is written only after
// the signed bundle is in object storage, and the write runs through `withTenant`, so RLS confines it to the tenant
// and a missing tenant context fails closed. Rows are immutable (the app role has SELECT and INSERT only). Each insert
// writes its `policy.snapshot.built` audit event in the same transaction, so a snapshot that cannot be audited is not
// recorded. The row holds ids, digests and the object key only, never the policy text.

import { desc, eq } from 'drizzle-orm';

import { newId } from '@blackwing/ids';

import { policySnapshots, type PolicySnapshotRow } from './schema/policy-snapshots.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';

/** One stored snapshot as callers read it (the `snapshot_sha256` is the snapshot id). */
export type PolicySnapshotEntry = PolicySnapshotRow;

/** The audit event of a recorded snapshot. Metadata carries the snapshot id, versions and key id only. */
export interface PolicySnapshotAuditEvent {
  readonly action: 'policy.snapshot.built';
  readonly tenantId: string;
  readonly snapshotSha256: string;
  readonly signingKeyId: string;
  readonly baselineVersion: string;
  readonly tenantPolicyVersion: number | null;
}

/** Audit hook (§8.8): runs inside the insert's transaction; a throw rolls the row back. */
export type PolicySnapshotAuditHook = (
  event: PolicySnapshotAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface PolicySnapshotRepositoryOptions {
  readonly db: Database;
  readonly audit: PolicySnapshotAuditHook;
}

/** What to record for a published snapshot; shape matches `NewPolicySnapshotRecord` of `@blackwing/policy`. */
export interface PolicySnapshotRecordInput {
  readonly tenantId: string;
  readonly snapshotSha256: string;
  readonly signingKeyId: string;
  readonly baselineVersion: string;
  readonly tenantPolicyVersion: number | null;
  readonly objectKey: string;
}

export class PolicySnapshotRepository {
  constructor(private readonly options: PolicySnapshotRepositoryOptions) {}

  /** Records a published snapshot and its audit event, in one transaction. Immutable: there is no update. */
  async insert(input: PolicySnapshotRecordInput): Promise<void> {
    await withTenant(this.options.db, input.tenantId, async (tx) => {
      await tx.insert(policySnapshots).values({
        id: newId(),
        tenantId: input.tenantId,
        snapshotSha256: input.snapshotSha256,
        signingKeyId: input.signingKeyId,
        baselineVersion: input.baselineVersion,
        tenantPolicyVersion: input.tenantPolicyVersion,
        objectKey: input.objectKey,
      });
      await this.options.audit(
        {
          action: 'policy.snapshot.built',
          tenantId: input.tenantId,
          snapshotSha256: input.snapshotSha256,
          signingKeyId: input.signingKeyId,
          baselineVersion: input.baselineVersion,
          tenantPolicyVersion: input.tenantPolicyVersion,
        },
        tx,
      );
    });
  }

  /** The tenant's current snapshot: the most recently recorded one, or `undefined` before the first build. */
  async latestForTenant(tenantId: string): Promise<PolicySnapshotEntry | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(policySnapshots)
        .where(eq(policySnapshots.tenantId, tenantId))
        .orderBy(desc(policySnapshots.createdAt), desc(policySnapshots.id))
        .limit(1);
      return row;
    });
  }
}
