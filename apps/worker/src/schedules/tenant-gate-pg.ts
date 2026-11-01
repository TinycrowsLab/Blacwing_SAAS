import { eq } from 'drizzle-orm';

import { tenants, withTenant, type Database } from '@blackwing/db';

import type { TenantStatusGate } from './ports.js';

/**
 * The Postgres tenant gate of the ScheduleManager (SCHED-003, ADMIN). Reads the tenant's own status row through
 * `withTenant`, so RLS confines it. Fails closed: a tenant that is not `active`, or whose row cannot be read, is
 * treated as suspended, so its schedules never resume.
 */
export function createPgTenantStatusGate(db: Database): TenantStatusGate {
  return {
    async isSuspended(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ status: tenants.status })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      );
      return row?.status !== 'active';
    },
  };
}
