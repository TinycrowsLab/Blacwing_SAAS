/** The stored organisation profile of one tenant, as the service reads it. */
export interface TenantProfileRecord {
  readonly name: string;
  readonly slug: string;
  readonly region: string;
  readonly plan: string;
  readonly status: string;
  readonly settings: Record<string, unknown>;
  readonly updatedAt: Date;
}

/** One changed field: the value before and after (personal-data values already redacted). */
export interface TenantProfileChange {
  readonly from: unknown;
  readonly to: unknown;
}

/** A committed change: the new name and settings, and the redacted diff for the audit event. */
export interface TenantProfileWrite {
  readonly name: string;
  readonly settings: Record<string, unknown>;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, TenantProfileChange>>;
}

/**
 * Tenant-scoped organisation profile persistence (the Postgres adapter is `TenantProfileRepository` in
 * @blackwing/db). `update` runs `mutate` on the locked row; a stale precondition throws from `mutate`, and
 * nothing is written. The write and its audit event commit together, or not at all.
 */
export interface TenantProfileStore {
  read(tenantId: string): Promise<TenantProfileRecord | undefined>;
  update(
    tenantId: string,
    mutate: (current: TenantProfileRecord) => TenantProfileWrite | undefined,
  ): Promise<{ readonly record: TenantProfileRecord; readonly changed: boolean }>;
}
