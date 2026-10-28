import type { TenantSettingsChange } from './settings.js';

/** The stored settings of one tenant, as the service reads them. */
export interface TenantSettingsRecord {
  readonly settings: Record<string, unknown>;
  readonly region: string;
  readonly updatedAt: Date;
}

/** A committed change: the new settings and the redacted diff for the audit event. */
export interface TenantSettingsWrite {
  readonly settings: Record<string, unknown>;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, TenantSettingsChange>>;
}

/**
 * Tenant-scoped settings persistence (the Postgres adapter is `TenantSettingsRepository` in @blackwing/db).
 * `update` runs `mutate` on the locked row; a stale precondition throws from `mutate`, and nothing is
 * written. Writes and their audit event commit together, or not at all.
 */
export interface TenantSettingsStore {
  read(tenantId: string): Promise<TenantSettingsRecord | undefined>;
  update(
    tenantId: string,
    mutate: (current: TenantSettingsRecord) => TenantSettingsWrite | undefined,
  ): Promise<{ readonly record: TenantSettingsRecord; readonly changed: boolean }>;
}

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface TenantSettingsMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}
