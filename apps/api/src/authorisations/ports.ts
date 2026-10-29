import type {
  NewStandingAuthorisation,
  StandingAuthorisationAuditEvent,
  StandingAuthorisationRecord,
  StandingAuthorisationWrite,
} from '@blackwing/db';

/** The audit fields a caller supplies; the tenant is filled in by the repository. */
type StandingAuthorisationAuditDraft = Omit<StandingAuthorisationAuditEvent, 'tenantId'>;

/**
 * Tenant-scoped standing-authorisation persistence (the Postgres adapter is `StandingAuthorisationRepository`
 * in @blackwing/db). `writeIf` changes the row only while it still holds `expectedVersion`; `undefined`
 * means a concurrent writer won or the row is gone.
 */
export interface StandingAuthorisationStore {
  insertDraft(
    tenantId: string,
    draft: NewStandingAuthorisation,
    audit: StandingAuthorisationAuditDraft,
  ): Promise<StandingAuthorisationRecord>;
  read(tenantId: string, id: string): Promise<StandingAuthorisationRecord | undefined>;
  list(
    tenantId: string,
    options: { readonly afterId?: string; readonly limit: number },
  ): Promise<readonly StandingAuthorisationRecord[]>;
  writeIf(
    tenantId: string,
    id: string,
    expectedVersion: number,
    write: StandingAuthorisationWrite,
    audit: StandingAuthorisationAuditDraft,
  ): Promise<StandingAuthorisationRecord | undefined>;
}

/**
 * Asset verification (ASSET epic, §8.10). Returns the ids that are not verified assets of the tenant; an
 * unknown or cross-tenant id counts as unverified. Kept behind a port so the ASSET module can be mocked.
 */
export interface AssetVerifier {
  unverified(tenantId: string, assetIds: readonly string[]): Promise<readonly string[]>;
}

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface AuthorisationMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}
