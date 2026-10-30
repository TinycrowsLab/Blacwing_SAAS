// Input-manifest persistence for uploads (SCOPE-006, CONTEXT_PACK §7, §8.6). The manifest's `spec_objects` list
// is written under a row lock, so two uploads of one manifest serialise. Every method runs through `withTenant`:
// RLS confines it, and a manifest of another tenant reads as absent (the caller answers 404).

import { eq, sql } from 'drizzle-orm';

import { memberships } from './schema/index.js';
import { inputManifests } from './schema/scope.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';

/** One row of `input_manifests`. */
export type InputManifestRow = typeof inputManifests.$inferSelect;

/** Persistence of the upload service. Tests of the service use an in-memory double with the same contract. */
export class InputManifestRepository {
  constructor(private readonly db: Database) {}

  /** Runs `fn` in one transaction of `tenantId`. The service commits a list change and its audit event together. */
  transact<R>(tenantId: string, fn: (tx: TenantTx) => Promise<R>): Promise<R> {
    return withTenant(this.db, tenantId, fn);
  }

  /** The manifest, locked for the rest of the transaction, or `undefined` when it is not in this tenant. */
  async lockById(tx: TenantTx, id: string): Promise<InputManifestRow | undefined> {
    const rows = await tx
      .select()
      .from(inputManifests)
      .where(eq(inputManifests.id, id))
      .for('update')
      .limit(1);
    return rows[0];
  }

  /** Replaces the manifest's spec object list (the caller holds the row lock from `lockById`). */
  async setSpecObjects(tx: TenantTx, id: string, specObjects: readonly unknown[]): Promise<void> {
    await tx
      .update(inputManifests)
      .set({ specObjects: [...specObjects], updatedAt: sql`now()` })
      .where(eq(inputManifests.id, id));
  }

  /** The roles `userId` holds in this tenant, or `undefined` when the user is not a member (RLS keeps it in-tenant). */
  async rolesOf(tx: TenantTx, userId: string): Promise<readonly string[] | undefined> {
    const rows = await tx
      .select({ roles: memberships.roles })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    return rows[0]?.roles;
  }
}
