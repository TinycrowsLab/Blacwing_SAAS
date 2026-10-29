// Standing-authorisation reads for the submit gate (SCOPE-005, AUTHZ-001). Read-only: the AUTHZ lifecycle owns writes.
// Runs in the named tenant's `withTenant` transaction, so another tenant's SA reads as absent (no existence leak).

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { TenantContextMissingError } from '@blackwing/errors';

import { standingAuthorisations } from './schema/authorisation.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { IntrusivenessClass } from '@blackwing/contracts';

/** A stored budget ceiling: each bound a number. A malformed stored value fails the read (fail closed). */
const budgetCeilingSchema = z.record(z.string(), z.number());

/** The standing authorisation as the submit gate reads it. */
export interface StandingAuthorisationEntry {
  readonly id: string;
  readonly status: 'draft' | 'pending_approval' | 'active' | 'expired' | 'revoked';
  readonly expiresAt: Date;
  readonly validFrom: Date;
  readonly assetIds: readonly string[];
  readonly scopeRules: unknown;
  readonly maxIntrusiveness: IntrusivenessClass;
  readonly defaultBudgets: Readonly<Record<string, number>>;
}

export interface StandingAuthorisationReaderOptions {
  readonly db: Database;
}

/** Tenant-scoped standing-authorisation reads. */
export class StandingAuthorisationReader {
  private readonly options: StandingAuthorisationReaderOptions;

  constructor(options: StandingAuthorisationReaderOptions) {
    this.options = options;
  }

  /** The SA `saId` of `tenantId`, or `undefined` (also for another tenant's SA). */
  async findInTenant(
    tenantId: string,
    saId: string,
  ): Promise<StandingAuthorisationEntry | undefined> {
    if (tenantId === '') {
      throw new TenantContextMissingError(
        'no tenant context: refusing to read a standing authorisation',
      );
    }
    const row = await withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(standingAuthorisations)
        .where(
          and(eq(standingAuthorisations.id, saId), eq(standingAuthorisations.tenantId, tenantId)),
        )
        .limit(1);
      return rows[0];
    });
    if (row === undefined) return undefined;
    return {
      id: row.id,
      status: row.status,
      expiresAt: row.expiresAt,
      validFrom: row.validFrom,
      assetIds: [...row.assetIds],
      scopeRules: row.scopeRules,
      maxIntrusiveness: row.maxIntrusiveness,
      defaultBudgets: budgetCeilingSchema.parse(row.defaultBudgets),
    };
  }
}
