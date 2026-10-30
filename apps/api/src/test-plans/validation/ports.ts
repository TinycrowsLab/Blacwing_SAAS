import type { PlanValidatedAuditEvent, PlanValidationSnapshot } from '@blackwing/db';

/**
 * Tenant-scoped reads and the audit write of plan validation. The Postgres adapter is `PlanValidationRepository`
 * (@blackwing/db): `snapshot` reads one consistent view in a single `withTenant` transaction, and `recordValidated`
 * appends the `test_plan.validated` event through the audit hook. A plan of another tenant reads as absent.
 */
export interface PlanValidationStore {
  snapshot(tenantId: string, planId: string): Promise<PlanValidationSnapshot | undefined>;
  recordValidated(event: PlanValidatedAuditEvent): Promise<void>;
}
