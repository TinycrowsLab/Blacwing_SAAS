// Tenant settings persistence (TENANT-008, CONTEXT_PACK §7, §8.6, §8.8). The settings are a typed JSONB
// column on `tenants`. Every method runs through `withTenant`, so RLS confines it and a missing tenant
// context fails closed. An update locks the tenant row, lets the caller check the precondition
// (If-Match) against the locked state, and writes the settings and their audit event in one transaction:
// a change that cannot be audited does not happen, and two writers cannot both pass the same ETag.

import { and, eq } from 'drizzle-orm';

import { NotFoundError } from '@blackwing/errors';

import { memberships, tenants } from './schema/tenancy.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';

/** The stored state of a tenant's settings: the raw JSONB and the instant it last changed. */
export interface TenantSettingsRecord {
  readonly settings: Record<string, unknown>;
  readonly region: string;
  readonly updatedAt: Date;
}

/** One changed key. Values are already redacted by the caller when the key holds personal data. */
export interface TenantSettingsChange {
  readonly from: unknown;
  readonly to: unknown;
}

/** What a mutation returns to write: the new settings and the audit details of the change. */
export interface TenantSettingsWrite {
  readonly settings: Record<string, unknown>;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, TenantSettingsChange>>;
}

/** The audit event of a committed settings change (`tenant.settings_updated`), written in the same transaction. */
export interface TenantSettingsAuditEvent {
  readonly action: 'tenant.settings_updated';
  readonly tenantId: string;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, TenantSettingsChange>>;
}

/** Audit hook (§8.8): runs inside the update's transaction, so a failure rolls the change back. */
export type TenantSettingsAuditHook = (
  event: TenantSettingsAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface TenantSettingsRepositoryOptions {
  readonly db: Database;
  readonly audit: TenantSettingsAuditHook;
}

const selectSettings = {
  settings: tenants.settings,
  region: tenants.region,
  updatedAt: tenants.updatedAt,
};

/** Tenant-scoped persistence of the settings and the caller's membership roles. */
export class TenantSettingsRepository {
  private readonly options: TenantSettingsRepositoryOptions;

  constructor(options: TenantSettingsRepositoryOptions) {
    this.options = options;
  }

  /** The settings of `tenantId`, or `undefined` when the tenant is not visible to the caller (RLS). */
  async read(tenantId: string): Promise<TenantSettingsRecord | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select(selectSettings)
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0];
    });
  }

  /**
   * Runs `mutate` on the locked settings of `tenantId`. It returns the write to commit, or `undefined`
   * for a no-op (nothing is written and nothing is audited). `mutate` may throw to refuse the change
   * (for example a stale If-Match); the transaction then rolls back. `changed` tells the caller whether
   * a write was committed.
   */
  async update(
    tenantId: string,
    mutate: (current: TenantSettingsRecord) => TenantSettingsWrite | undefined,
  ): Promise<{ readonly record: TenantSettingsRecord; readonly changed: boolean }> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [current] = await tx
        .select(selectSettings)
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
        .for('update');
      if (current === undefined) throw new NotFoundError('tenant not found');
      const write = mutate(current);
      if (write === undefined) return { record: current, changed: false };
      const [updated] = await tx
        .update(tenants)
        .set({ settings: write.settings })
        .where(eq(tenants.id, tenantId))
        .returning(selectSettings);
      if (updated === undefined) throw new NotFoundError('tenant not found');
      await this.options.audit(
        {
          action: 'tenant.settings_updated',
          tenantId,
          actorId: write.actorId,
          changes: write.changes,
        },
        tx,
      );
      return { record: updated, changed: true };
    });
  }

  /** The tenant roles `userId` holds in `tenantId`; empty when there is no membership (RLS and the filter). */
  async rolesOf(tenantId: string, userId: string): Promise<readonly string[]> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ roles: memberships.roles })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
        .limit(1);
      return rows[0]?.roles ?? [];
    });
  }
}
