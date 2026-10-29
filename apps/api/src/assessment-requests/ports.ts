import type {
  AssessmentRequestStatus,
  BudgetCeiling,
  IntrusivenessClass,
  VerificationStatus,
} from '@blackwing/contracts';
import type {
  AssessmentRequestCreate,
  AssessmentRequestRow,
  AssessmentRequestUpdate,
} from '@blackwing/db';

/**
 * The persistence the assessment-request service composes (SCOPE-005). The Postgres adapter is
 * `AssessmentRequestRepository` in @blackwing/db: it runs every query in the ambient tenant's `withTenant`
 * transaction, so a request of another tenant reads as absent. Tests pass an in-memory fake with that contract.
 */
export interface AssessmentRequestStore {
  create(input: AssessmentRequestCreate): Promise<AssessmentRequestRow>;
  findById(id: string): Promise<AssessmentRequestRow | undefined>;
  list(): Promise<AssessmentRequestRow[]>;
  updateDraft(
    id: string,
    expectedStateVersion: number,
    patch: AssessmentRequestUpdate,
    actorId: string,
  ): Promise<AssessmentRequestRow>;
  transition(
    id: string,
    expectedStateVersion: number,
    to: AssessmentRequestStatus,
    actorId: string,
  ): Promise<AssessmentRequestRow>;
}

/** One asset the caller's tenant can see, with its ownership verification state (§8.10). */
export interface AssetFact {
  readonly id: string;
  readonly verificationStatus: VerificationStatus;
  /** The owner, for the asset-level Cedar check (`assessment/policy.ts`). */
  readonly ownerUserId: string;
}

/** Asset lookup. Tenant-scoped: an asset of another tenant is simply absent from the result. */
export interface AssetCatalog {
  findInTenant(tenantId: string, assetIds: readonly string[]): Promise<readonly AssetFact[]>;
}

/** A standing authorisation as the submit gate reads it (AUTHZ-001, §8.1). */
export interface StandingAuthorisationFact {
  readonly id: string;
  readonly status: 'draft' | 'pending_approval' | 'active' | 'expired' | 'revoked';
  /** The start of the SA window; the SA is not active before it. */
  readonly validFrom: Date;
  readonly expiresAt: Date;
  readonly assetIds: readonly string[];
  /** Include/exclude rules, `{ rules: [...] }` (SCOPE-002). */
  readonly scopeRules: unknown;
  readonly maxIntrusiveness: IntrusivenessClass;
  readonly defaultBudgets: BudgetCeiling;
}

/** Standing-authorisation lookup. Tenant-scoped: another tenant's SA reads as absent (no existence leak). */
export interface StandingAuthorisationReader {
  findInTenant(tenantId: string, saId: string): Promise<StandingAuthorisationFact | undefined>;
}

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface AssessmentRequestMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}

/** Tenant kill switch (§8.4): a halted tenant may not submit a request. */
export interface TenantHaltState {
  isHalted(tenantId: string): Promise<boolean>;
}
