import type { FindingOccurrenceRow, FindingQuery, FindingRow } from '@blackwing/db';

/**
 * Persistence the finding query service composes (FINDING-001). The Postgres adapter is `FindingRepository` in
 * @blackwing/db: every call runs in the ambient tenant's `withTenant` transaction, so another tenant's finding
 * reads as absent. Tests pass an in-memory fake with that contract.
 */
export interface FindingStore {
  /** Findings of the ambient tenant matching `query`, newest first. */
  search(query: FindingQuery): Promise<FindingRow[]>;
  /** One finding of the ambient tenant, or `undefined` (also for another tenant's). */
  findById(id: string): Promise<FindingRow | undefined>;
  /** Every occurrence of one finding, oldest first. */
  listOccurrences(findingId: string): Promise<FindingOccurrenceRow[]>;
  /** Occurrences of several findings in one read, oldest first (the GraphQL batch). */
  listOccurrencesOf(findingIds: readonly string[]): Promise<FindingOccurrenceRow[]>;
}

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface FindingMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}
