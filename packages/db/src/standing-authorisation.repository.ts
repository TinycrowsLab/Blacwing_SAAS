// Standing-authorisation persistence (AUTHZ-002, CONTEXT_PACK §7, §8.6, §8.8). Every method runs through
// `withTenant`, so RLS confines it and a missing tenant context fails closed. A write is a conditional
// `UPDATE ... WHERE version = $expected`: two writers cannot both pass the same ETag, and the loser gets
// `undefined` and reloads. The row change and its audit event commit in one transaction, or not at all.

import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { standingAuthorisations, type StandingAuthorisationRow } from './schema/authorisation.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type { IntrusivenessClass, SaStatus } from '@blackwing/contracts';

/** A stored standing authorisation, as the service reads it. */
export type StandingAuthorisationRecord = StandingAuthorisationRow;

/** The caller-set fields of a draft. Timestamps are already parsed. */
export interface StandingAuthorisationFields {
  readonly assetIds: readonly string[];
  readonly scopeRules: Record<string, unknown>;
  readonly maxIntrusiveness: IntrusivenessClass;
  readonly preApprovedTestClasses: readonly string[];
  readonly defaultBudgets: Record<string, unknown>;
  readonly testWindows: readonly Record<string, unknown>[];
  readonly validFrom: Date;
  readonly expiresAt: Date;
}

/** A new draft: its uuid and public id are minted by the caller, so the audit event can name them. */
export interface NewStandingAuthorisation extends StandingAuthorisationFields {
  readonly id: string;
  readonly publicId: string;
  readonly requesterId: string;
}

/** The audit actions of the standing-authorisation API (AUTHZ-002). */
export type StandingAuthorisationAuditAction =
  'authz.sa.created' | 'authz.sa.updated' | 'authz.sa.submitted';

/**
 * A committed change: the action, the acting user and the changed field names (never their values). A
 * submit also records the status it moved from and to.
 */
export interface StandingAuthorisationAuditEvent {
  readonly action: StandingAuthorisationAuditAction;
  readonly tenantId: string;
  readonly actorId: string;
  readonly saId: string;
  readonly changedFields: readonly string[];
  readonly from?: SaStatus;
  readonly to?: SaStatus;
}

/** Audit hook (§8.8): runs inside the write's transaction, so a failure rolls the change back. */
export type StandingAuthorisationAuditHook = (
  event: StandingAuthorisationAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface StandingAuthorisationRepositoryOptions {
  readonly db: Database;
  readonly audit: StandingAuthorisationAuditHook;
}

/** The status and fields a conditional write sets, on top of the version bump. */
export interface StandingAuthorisationWrite {
  readonly fields: Partial<StandingAuthorisationFields>;
  readonly status?: SaStatus;
}

/** Tenant-scoped persistence of standing authorisations. */
export class StandingAuthorisationRepository {
  private readonly options: StandingAuthorisationRepositoryOptions;

  constructor(options: StandingAuthorisationRepositoryOptions) {
    this.options = options;
  }

  /** Inserts a draft at version 1 and records `authz.sa.created` in the same transaction. */
  async insertDraft(
    tenantId: string,
    draft: NewStandingAuthorisation,
    audit: Omit<StandingAuthorisationAuditEvent, 'tenantId'>,
  ): Promise<StandingAuthorisationRecord> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(standingAuthorisations)
        .values({
          id: draft.id,
          tenantId,
          publicId: draft.publicId,
          assetIds: [...draft.assetIds],
          scopeRules: draft.scopeRules,
          maxIntrusiveness: draft.maxIntrusiveness,
          preApprovedTestClasses: [...draft.preApprovedTestClasses],
          defaultBudgets: draft.defaultBudgets,
          testWindows: [...draft.testWindows],
          validFrom: draft.validFrom,
          expiresAt: draft.expiresAt,
          requesterId: draft.requesterId,
          status: 'draft',
        })
        .returning();
      if (row === undefined) throw new Error('standing authorisation insert returned no row');
      await this.options.audit({ ...audit, tenantId }, tx);
      return row;
    });
  }

  /** The standing authorisation `id` of `tenantId`, or `undefined` when it is not visible to the caller (RLS). */
  async read(tenantId: string, id: string): Promise<StandingAuthorisationRecord | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(standingAuthorisations)
        .where(
          and(eq(standingAuthorisations.tenantId, tenantId), eq(standingAuthorisations.id, id)),
        )
        .limit(1);
      return rows[0];
    });
  }

  /** One keyset page in id order (UUIDv7, so time order): rows strictly after `afterId`, `limit + 1` at most. */
  async list(
    tenantId: string,
    options: { readonly afterId?: string; readonly limit: number },
  ): Promise<readonly StandingAuthorisationRecord[]> {
    return withTenant(this.options.db, tenantId, (tx) => {
      const scope = eq(standingAuthorisations.tenantId, tenantId);
      return tx
        .select()
        .from(standingAuthorisations)
        .where(
          options.afterId === undefined
            ? scope
            : and(scope, gt(standingAuthorisations.id, options.afterId)),
        )
        .orderBy(asc(standingAuthorisations.id))
        .limit(options.limit + 1);
    });
  }

  /**
   * Applies `write` only while the row still holds `expectedVersion`, bumps `version` and records the
   * audit event. Returns `undefined` when no row matched: a concurrent writer won, or the row is gone.
   */
  async writeIf(
    tenantId: string,
    id: string,
    expectedVersion: number,
    write: StandingAuthorisationWrite,
    audit: Omit<StandingAuthorisationAuditEvent, 'tenantId'>,
  ): Promise<StandingAuthorisationRecord | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const { assetIds, testWindows, preApprovedTestClasses, ...scalars } = write.fields;
      const set = {
        ...scalars,
        ...(assetIds === undefined ? {} : { assetIds: [...assetIds] }),
        ...(preApprovedTestClasses === undefined
          ? {}
          : { preApprovedTestClasses: [...preApprovedTestClasses] }),
        ...(testWindows === undefined ? {} : { testWindows: [...testWindows] }),
        ...(write.status === undefined ? {} : { status: write.status }),
        version: sql`${standingAuthorisations.version} + 1`,
      };
      const [row] = await tx
        .update(standingAuthorisations)
        .set(set)
        .where(
          and(
            eq(standingAuthorisations.tenantId, tenantId),
            eq(standingAuthorisations.id, id),
            eq(standingAuthorisations.version, expectedVersion),
          ),
        )
        .returning();
      if (row === undefined) return undefined;
      await this.options.audit({ ...audit, tenantId }, tx);
      return row;
    });
  }
}
