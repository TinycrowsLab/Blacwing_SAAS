// Organisation profile persistence (ADMIN-001, CONTEXT_PACK §7, §8.6, §8.8). The name is the `tenants.name`
// column; the editable support contact and display zone live in the typed `tenants.settings` JSONB. Every
// method runs through `withTenant`, so RLS confines it and a missing tenant context fails closed. An update
// locks the tenant row, lets the caller check the precondition (If-Match) against the locked state, and
// writes the row and its audit event in one transaction: a change that cannot be audited does not happen,
// and two writers cannot both pass the same ETag.

import { eq } from 'drizzle-orm';

import { NotFoundError } from '@blackwing/errors';

import { tenants } from './schema/tenancy.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type { TenantSettingsChange } from './tenant-settings.repository.js';

/** The stored organisation profile: the row's name and settings, its read-only columns and its last change. */
export interface TenantProfileRecord {
  readonly name: string;
  readonly slug: string;
  readonly region: string;
  readonly plan: string;
  readonly status: string;
  readonly settings: Record<string, unknown>;
  readonly updatedAt: Date;
}

/** What a mutation returns to write: the new name and settings, and the redacted diff for the audit. */
export interface TenantProfileWrite {
  readonly name: string;
  readonly settings: Record<string, unknown>;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, TenantSettingsChange>>;
}

/** The audit event of a committed profile change (`org.settings.updated`), written in the same transaction. */
export interface OrgSettingsAuditEvent {
  readonly action: 'org.settings.updated';
  readonly tenantId: string;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, TenantSettingsChange>>;
}

/** Audit hook (§8.8): runs inside the update's transaction, so a failure rolls the change back. */
export type OrgSettingsAuditHook = (
  event: OrgSettingsAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface TenantProfileRepositoryOptions {
  readonly db: Database;
  readonly audit: OrgSettingsAuditHook;
}

const selectProfile = {
  name: tenants.name,
  slug: tenants.slug,
  region: tenants.region,
  plan: tenants.plan,
  status: tenants.status,
  settings: tenants.settings,
  updatedAt: tenants.updatedAt,
};

/** Tenant-scoped persistence of the organisation profile. */
export class TenantProfileRepository {
  private readonly options: TenantProfileRepositoryOptions;

  constructor(options: TenantProfileRepositoryOptions) {
    this.options = options;
  }

  /** The profile of `tenantId`, or `undefined` when the tenant is not visible to the caller (RLS). */
  async read(tenantId: string): Promise<TenantProfileRecord | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select(selectProfile)
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0];
    });
  }

  /**
   * Runs `mutate` on the locked profile of `tenantId`. It returns the write to commit, or `undefined` for a
   * no-op (nothing is written and nothing is audited). `mutate` may throw to refuse the change (for example a
   * stale If-Match); the transaction then rolls back. `changed` tells the caller whether a write was committed.
   */
  async update(
    tenantId: string,
    mutate: (current: TenantProfileRecord) => TenantProfileWrite | undefined,
  ): Promise<{ readonly record: TenantProfileRecord; readonly changed: boolean }> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [current] = await tx
        .select(selectProfile)
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
        .for('update');
      if (current === undefined) throw new NotFoundError('tenant not found');
      const write = mutate(current);
      if (write === undefined) return { record: current, changed: false };
      const [updated] = await tx
        .update(tenants)
        .set({ name: write.name, settings: write.settings })
        .where(eq(tenants.id, tenantId))
        .returning(selectProfile);
      if (updated === undefined) throw new NotFoundError('tenant not found');
      await this.options.audit(
        {
          action: 'org.settings.updated',
          tenantId,
          actorId: write.actorId,
          changes: write.changes,
        },
        tx,
      );
      return { record: updated, changed: true };
    });
  }
}
