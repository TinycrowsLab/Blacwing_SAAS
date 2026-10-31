import type { FindingTriageRequest, FindingTriageResult } from '@blackwing/db';

/**
 * Persistence of the Gate 3 decisions (TRIAGE-001). The Postgres adapter is `FindingTriageRepository` in @blackwing/db:
 * each call runs in the tenant's `withTenant` transaction and writes the finding change, its gate decision and its audit
 * event together, or nothing. A stale `expectedStateVersion` is a `ConcurrencyError`; a finding the tenant cannot see is a
 * `NotFoundError`. Tests pass an in-memory fake with the same contract.
 */
export interface TriageStore {
  transition(tenantId: string, request: FindingTriageRequest): Promise<FindingTriageResult>;
}
