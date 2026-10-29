// Standing-authorisation persistence (AUTHZ-002, CONTEXT_PACK §7, §8.6, §8.8). Every method runs through
// `withTenant`, so RLS confines it and a missing tenant context fails closed. A write is a conditional
// `UPDATE ... WHERE version = $expected`: two writers cannot both pass the same ETag, and the loser gets
// `undefined` and reloads. The row change and its audit event commit in one transaction, or not at all.

import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { type GateDecisionAuditEvent, recordGateDecision } from '@blackwing/domain';

import { standingAuthorisations, type StandingAuthorisationRow } from './schema/authorisation.js';
import { authzGateDecisions } from './schema/authz-gate-decisions.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type { GateDecision, IntrusivenessClass, SaStatus } from '@blackwing/contracts';

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
  | 'authz.sa.created'
  | 'authz.sa.updated'
  | 'authz.sa.submitted'
  | 'authz.sa.approved'
  | 'authz.sa.rejected';

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

/**
 * Audit hook for the gate decision a SA approval or rejection records (`authz.gate.decision`, §8.8). It runs in the
 * same transaction as the state change, so an unaudited decision is never recorded.
 */
export type GateDecisionAuditHook = (
  event: GateDecisionAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface StandingAuthorisationRepositoryOptions {
  readonly db: Database;
  readonly audit: StandingAuthorisationAuditHook;
  readonly gateAudit: GateDecisionAuditHook;
}

/** The approver and the signature an approval stores (AUTHZ-004 output, AUTHZ-008 approve). */
export interface StandingAuthorisationApproval {
  readonly approverId: string;
  readonly signature: string;
  readonly signingKeyId: string;
  readonly envelopeHash: string;
}

/** The decision a state change records as a gate decision on Gate 1 (the SA scope gate). */
export interface StandingAuthorisationDecision {
  readonly decision: Extract<GateDecision, 'approved' | 'rejected'>;
  readonly actorId: string;
  readonly reason: string | null;
  readonly decidedAt: Date;
}

/** The status and fields a conditional write sets, on top of the version bump. */
export interface StandingAuthorisationWrite {
  readonly fields: Partial<StandingAuthorisationFields>;
  readonly status?: SaStatus;
  /** Set by an approval: who approved and the signature the envelope verifies with. */
  readonly approval?: StandingAuthorisationApproval;
  /** Recorded in the same transaction: the gate decision row and its audit event. */
  readonly decision?: StandingAuthorisationDecision;
}

/** The SA subject of Gate 1 (`gate_decisions.subject_type`). */
const SA_GATE = 1;

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
        ...(write.approval === undefined
          ? {}
          : {
              approverId: write.approval.approverId,
              signature: write.approval.signature,
              signingKeyId: write.approval.signingKeyId,
              envelopeHash: write.approval.envelopeHash,
            }),
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
      if (write.decision !== undefined) {
        // The SoD check (requester = approver) runs inside this transaction too: a refusal rolls the change back.
        await recordGateDecision(
          {
            insert: async (decisionRow) => {
              await tx.insert(authzGateDecisions).values({ ...decisionRow, tenantId });
            },
            audit: async (event) => {
              await this.options.gateAudit(event, tx);
            },
          },
          {
            gate: SA_GATE,
            subjectType: 'sa',
            subjectId: row.id,
            decision: write.decision.decision,
            requesterId: row.requesterId,
            actorId: write.decision.actorId,
            reason: write.decision.reason,
            decidedAt: write.decision.decidedAt,
            timeoutAt: null,
            auto: false,
          },
        );
      }
      return row;
    });
  }
}
