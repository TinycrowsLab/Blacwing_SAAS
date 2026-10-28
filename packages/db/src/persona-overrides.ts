// Tenant-scoped persistence of persona overrides (REGISTRY-010, CONTEXT_PACK §7, §8.6, §8.8). Every
// statement runs through `withTenant`, so RLS confines it and a missing tenant fails closed. `replace`
// runs the caller's `afterWrite` in the same transaction, so the audit event that records a change commits
// together with the change or not at all.

import { and, eq, sql } from 'drizzle-orm';

import { personaOverrides, type PersonaOverrideRow } from './schema/persona-overrides.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';

/** The four whitelisted columns; `null` means "use the persona's base value". */
export interface PersonaOverrideColumns {
  readonly effort: string | null;
  readonly maxTurns: number | null;
  readonly maxBudgetUsd: number | null;
  readonly lowerStandardTier: boolean | null;
}

export interface StoredPersonaOverride extends PersonaOverrideColumns {
  readonly tenantId: string;
  readonly persona: string;
  readonly updatedAt: Date;
}

/** Stores one tenant's persona overrides. `Tx` is the transaction type the caller's audit write needs. */
export interface PgPersonaOverrideStore {
  find(tenantId: string, persona: string): Promise<StoredPersonaOverride | null>;
  replace(
    tenantId: string,
    persona: string,
    columns: PersonaOverrideColumns,
    afterWrite: (tx: TenantTx) => Promise<void>,
  ): Promise<StoredPersonaOverride>;
}

function toStored(row: PersonaOverrideRow): StoredPersonaOverride {
  return {
    tenantId: row.tenantId,
    persona: row.persona,
    effort: row.effort,
    maxTurns: row.maxTurns,
    maxBudgetUsd: row.maxBudgetUsd,
    lowerStandardTier: row.lowerStandardTier,
    updatedAt: row.updatedAt,
  };
}

export function createPgPersonaOverrideStore(db: Database): PgPersonaOverrideStore {
  return {
    async find(tenantId, persona) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(personaOverrides)
          .where(
            and(eq(personaOverrides.tenantId, tenantId), eq(personaOverrides.persona, persona)),
          )
          .limit(1);
        const [row] = rows;
        return row === undefined ? null : toStored(row);
      });
    },

    async replace(tenantId, persona, columns, afterWrite) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(personaOverrides)
          .values({ tenantId, persona, ...columns, updatedAt: sql`now()` })
          .onConflictDoUpdate({
            target: [personaOverrides.tenantId, personaOverrides.persona],
            set: { ...columns, updatedAt: sql`now()` },
          })
          .returning();
        if (row === undefined) throw new Error('persona override upsert returned no row');
        await afterWrite(tx);
        return toStored(row);
      });
    },
  };
}
