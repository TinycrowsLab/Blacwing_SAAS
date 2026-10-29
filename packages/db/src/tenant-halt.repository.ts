// Kill-switch state for the submit gate (SCOPE-005, §8.4, §8.5): a halted tenant accepts no new submission. A
// tenant-scope kill is in force until it is re-enabled (`reenabled_at` set). Runs in the tenant's `withTenant`.

import { and, eq, isNull } from 'drizzle-orm';

import { TenantContextMissingError } from '@blackwing/errors';

import { killEvents } from './schema/kill.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';

export interface TenantHaltRepositoryOptions {
  readonly db: Database;
}

/** Reads whether a tenant is halted by a kill that has not been re-enabled. */
export class TenantHaltRepository {
  private readonly options: TenantHaltRepositoryOptions;

  constructor(options: TenantHaltRepositoryOptions) {
    this.options = options;
  }

  async isHalted(tenantId: string): Promise<boolean> {
    if (tenantId === '')
      throw new TenantContextMissingError('no tenant context: refusing to read the kill state');
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: killEvents.id })
        .from(killEvents)
        .where(
          and(
            eq(killEvents.tenantId, tenantId),
            eq(killEvents.scope, 'tenant'),
            isNull(killEvents.reenabledAt),
          ),
        )
        .limit(1);
      return rows.length > 0;
    });
  }
}
