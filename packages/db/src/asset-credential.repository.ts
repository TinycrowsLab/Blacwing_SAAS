// Asset credential persistence (#363, CONTEXT_PACK §7, §8.6, §8.7). A credential row holds a `secret_ref`, the
// non-secret login recipe and the MFA type, never a secret value: the secret material is sealed by the caller and
// stored as the envelope of a `secrets` record the reference points at. Every method takes the tenant transaction
// (`TenantTx`), so the caller's write, its audit event and this row commit together or not at all (§8.8).

import { and, asc, eq, sql } from 'drizzle-orm';

import { assetCredentials, type AssetCredentialRow } from './schema/assets.js';
import { secrets } from './schema/secrets.js';

import type { TenantTx } from './with-tenant.js';
import type { MfaType, SecretType } from '@blackwing/contracts';

/** The `secrets` record that backs a credential: its sealed envelope and the metadata the resolver checks. */
export interface NewCredentialSecret {
  /** The secret record's id, the `{secretId}` of the credential's `secret_ref`. */
  readonly id: string;
  /** Unique per tenant; the credential id keeps it so, since a role name is free text. */
  readonly name: string;
  readonly type: SecretType;
  /** Envelope purpose (`asset_login`): part of the AAD, so the ciphertext opens only for login use. */
  readonly purpose: string;
  /** SECRETS-002 ciphertext envelope; never plaintext. */
  readonly envelope: Record<string, unknown>;
}

/** What a credential create commits: the row and the secret record it references, in one transaction. */
export interface NewAssetCredentialWrite {
  readonly id: string;
  readonly tenantId: string;
  readonly assetId: string;
  readonly roleName: string;
  /** `bw-secret://<tenant>/<secret>`, as {@link NewCredentialSecret.id} names it. */
  readonly secretRef: string;
  readonly loginRecipe: Record<string, unknown>;
  readonly mfaType: MfaType;
  readonly secret: NewCredentialSecret;
}

/**
 * Tenant-scoped persistence of asset credentials. Reads and writes go through the caller's transaction, so RLS
 * (`app.tenant_id`) and the explicit tenant predicate both apply, and a missing tenant context reads zero rows.
 */
export class AssetCredentialRepository {
  /**
   * Inserts the credential and its secret record. Returns `undefined` when the asset already has a credential for
   * this role (the unique `(asset_id, role_name)` key decides, so a concurrent create cannot double up). The
   * credential row is written first, so a conflict leaves no orphan secret record behind.
   */
  async insert(
    tx: TenantTx,
    write: NewAssetCredentialWrite,
  ): Promise<AssetCredentialRow | undefined> {
    const [row] = await tx
      .insert(assetCredentials)
      .values({
        id: write.id,
        tenantId: write.tenantId,
        assetId: write.assetId,
        roleName: write.roleName,
        secretRef: write.secretRef,
        loginRecipe: write.loginRecipe,
        mfaType: write.mfaType,
      })
      .onConflictDoNothing({
        target: [assetCredentials.assetId, assetCredentials.roleName],
      })
      .returning();
    if (row === undefined) return undefined;
    await tx.insert(secrets).values({
      id: write.secret.id,
      tenantId: write.tenantId,
      name: write.secret.name,
      type: write.secret.type,
      purpose: write.secret.purpose,
      backend: 'openbao',
      envelope: write.secret.envelope,
      currentVersion: 1,
      status: 'active',
    });
    return row;
  }

  /** The credential of one role of an asset in this tenant, or `undefined`. */
  async findByRole(
    tx: TenantTx,
    tenantId: string,
    assetId: string,
    roleName: string,
  ): Promise<AssetCredentialRow | undefined> {
    const rows = await tx
      .select()
      .from(assetCredentials)
      .where(
        and(
          eq(assetCredentials.tenantId, tenantId),
          eq(assetCredentials.assetId, assetId),
          eq(assetCredentials.roleName, roleName),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Every credential of an asset in this tenant, by role name. */
  async listByAsset(
    tx: TenantTx,
    tenantId: string,
    assetId: string,
  ): Promise<AssetCredentialRow[]> {
    return tx
      .select()
      .from(assetCredentials)
      .where(and(eq(assetCredentials.tenantId, tenantId), eq(assetCredentials.assetId, assetId)))
      .orderBy(asc(assetCredentials.roleName), asc(assetCredentials.id));
  }

  /** Records that a credential's secret was rotated (its `updated_at`); the version lives on the secret record. */
  async markRotated(
    tx: TenantTx,
    tenantId: string,
    id: string,
  ): Promise<AssetCredentialRow | undefined> {
    const rows = await tx
      .update(assetCredentials)
      .set({ updatedAt: sql`now()` })
      .where(and(eq(assetCredentials.tenantId, tenantId), eq(assetCredentials.id, id)))
      .returning();
    return rows[0];
  }
}
