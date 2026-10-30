import { type AuditEmitter, type AuditEventInput, createAuditEmitter } from '@blackwing/audit';
import {
  ASSET_CREDENTIAL_RECIPE_MAX_BYTES,
  type AssetCredentialListResponse,
  type AssetCredentialRotationView,
  type AssetCredentialView,
  type CreateAssetCredentialBody,
  createAssetCredentialBodySchema,
  credentialSecretRef,
  assetLoginRecipeSchema,
  missingCredentialSecrets,
  parseSecretRef,
  rotateAssetCredentialBodySchema,
} from '@blackwing/contracts';
import { NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  assetAuditInput,
  assetResource,
  authoriseAsset,
  type AssetCaller,
  type AssetOperation,
  inAssetSpan,
  memberRolesOf,
  rowIdOf,
} from './access.js';
import { auditSqlTx } from './audit-tx.js';
import { ASSET_LOGIN_SECRET_PURPOSE, type CredentialVault } from './credential-vault.js';
import {
  AssetCredentialDuplicateRoleError,
  AssetCredentialRecipeTooLargeError,
  AssetCredentialSecretWriteError,
} from './errors.js';

import type { AssetMetrics } from './metrics.js';
import type { AssetPolicyEngine, AssetPolicyResource } from './policy.js';
import type { AssetRepository } from './repository.js';
import type { AssetPrincipal } from './service.js';
import type {
  AssetCredentialRow,
  AssetCredentialRepository,
  AssetRow,
  TenantTx,
} from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

export interface AssetCredentialServiceDeps {
  /** Asset reads (live row, membership roles) in the caller's tenant transaction. */
  readonly assets: AssetRepository;
  /** The credential rows and their secret records, written in the same transaction as the audit event. */
  readonly credentials: AssetCredentialRepository;
  readonly vault: CredentialVault;
  readonly policy: AssetPolicyEngine;
  readonly audit?: AuditEmitter;
  readonly metrics: AssetMetrics;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

/** Field paths only: a Zod message can echo a submitted value, and a value may be a credential. */
function invalidCredential(paths: readonly string[]): ValidationError {
  const fields = [...new Set(paths)];
  return new ValidationError('invalid asset credential', {
    detail: `Invalid fields: ${fields.length === 0 ? '(body)' : fields.join(', ')}.`,
  });
}

/** The view of a stored credential: the recipe and the reference, never a secret (§8.7). */
function toAssetCredentialView(row: AssetCredentialRow): AssetCredentialView {
  const recipe = assetLoginRecipeSchema.parse(row.loginRecipe);
  return {
    id: row.id,
    roleName: row.roleName,
    loginRecipe: recipe,
    mfaType: row.mfaType,
    secretRef: row.secretRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Byte length of a JSON value, for the recipe cap. An undefined value (no recipe) is zero bytes. */
function jsonBytes(value: unknown): number {
  // JSON.stringify returns undefined for a value with no JSON form (e.g. an absent recipe).
  const json = JSON.stringify(value) as string | undefined;
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
}

/** Parses a create body (`unknown` from the wire). Refuses an oversized recipe with 413 before any parse. */
function parseCreateBody(body: unknown): CreateAssetCredentialBody {
  if (typeof body === 'object' && body !== null && 'loginRecipe' in body) {
    if (jsonBytes(body.loginRecipe) > ASSET_CREDENTIAL_RECIPE_MAX_BYTES) {
      throw new AssetCredentialRecipeTooLargeError();
    }
  }
  const parsed = createAssetCredentialBodySchema.safeParse(body);
  if (!parsed.success) {
    throw invalidCredential(parsed.error.issues.map((issue) => issue.path.map(String).join('.')));
  }
  const missing = missingCredentialSecrets(
    parsed.data.loginRecipe,
    parsed.data.mfaType,
    parsed.data.secrets,
  );
  if (missing.length > 0) {
    throw new ValidationError('the credential is missing required secrets', {
      detail: `Missing required fields: ${missing.join(', ')}.`,
    });
  }
  return parsed.data;
}

/** The secret bundle as the Secrets Service stores it: one JSON document of the values that were sent. */
function bundleOf(secrets: CreateAssetCredentialBody['secrets']): string {
  return JSON.stringify(secrets);
}

/** The secret type of a bundle: a bearer token when only a token was sent, otherwise a password. */
function secretTypeOf(secrets: CreateAssetCredentialBody['secrets']): 'password' | 'token' {
  return secrets.password === undefined && secrets.token !== undefined ? 'token' : 'password';
}

/**
 * Asset login credentials (#363): per-role logins of an asset, stored by reference. The secret material is sealed
 * by the Secrets Service (`CredentialVault`) before any row is written, and only the `secret_ref`, the recipe and the
 * MFA type are persisted. Every call authorises first (RBAC permission, then the Cedar resource check, like the asset
 * API). A foreign-tenant or unknown asset is `404`. Each write commits with its audit event (§8.8).
 */
export class AssetCredentialService {
  private readonly audit: AuditEmitter;

  constructor(private readonly deps: AssetCredentialServiceDeps) {
    this.audit = deps.audit ?? createAuditEmitter();
  }

  /** Every credential of the asset, by role name. */
  async list(principal: AssetPrincipal, assetId: string): Promise<AssetCredentialListResponse> {
    return inAssetSpan('credentials.list', () =>
      this.deps.assets.transact('credentials.list', async (tx) => {
        const asset = await this.authorisedAsset(tx, principal, assetId, 'read');
        const rows = await this.deps.credentials.listByAsset(tx, principal.tenantId, asset.id);
        return { items: rows.map((row) => toAssetCredentialView(row)) };
      }),
    );
  }

  /** One credential of the asset by role name, or `404`. */
  async get(
    principal: AssetPrincipal,
    assetId: string,
    roleName: string,
  ): Promise<AssetCredentialView> {
    return inAssetSpan('credentials.get', () =>
      this.deps.assets.transact('credentials.get', async (tx) => {
        const asset = await this.authorisedAsset(tx, principal, assetId, 'read');
        const row = await this.credentialOf(tx, principal.tenantId, asset.id, roleName);
        return toAssetCredentialView(row);
      }),
    );
  }

  /**
   * Stores a new role login. Order: authorise and validate; seal the secret with the Secrets Service (a refusal is
   * `503` and nothing is written); then commit the credential row, its secret record and the audit event together.
   * A role that already has a credential is `409`.
   */
  async create(
    principal: AssetPrincipal,
    assetId: string,
    body: unknown,
  ): Promise<AssetCredentialView> {
    return inAssetSpan('credentials.create', async () => {
      const parsed = parseCreateBody(body);
      const asset = await this.deps.assets.transact('credentials.authorise', (tx) =>
        this.authorisedAsset(tx, principal, assetId, 'update'),
      );
      const credentialId = newId();
      const secretId = newId();
      const secretRef = credentialSecretRef(principal.tenantId, secretId);
      const envelope = await this.seal(principal.tenantId, secretId, bundleOf(parsed.secrets));
      const row = await this.deps.assets.transact('credentials.create', async (tx) => {
        await this.authorisedAsset(tx, principal, asset.id, 'update');
        const inserted = await this.deps.credentials.insert(tx, {
          id: credentialId,
          tenantId: principal.tenantId,
          assetId: asset.id,
          roleName: parsed.roleName,
          secretRef,
          loginRecipe: parsed.loginRecipe,
          mfaType: parsed.mfaType,
          secret: {
            id: secretId,
            name: `asset_credential:${credentialId}`,
            type: secretTypeOf(parsed.secrets),
            purpose: ASSET_LOGIN_SECRET_PURPOSE,
            envelope: { ...envelope },
          },
        });
        if (inserted === undefined) throw new AssetCredentialDuplicateRoleError();
        await this.audit.emitAuditInTx(
          auditSqlTx(tx),
          this.auditInput(principal, 'asset.credential_added', asset, {
            roleName: parsed.roleName,
            mfaType: parsed.mfaType,
          }),
        );
        return inserted;
      });
      this.deps.metrics.credentialAdded(row.mfaType);
      this.deps.logger.info(
        {
          assetId: asset.publicId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          roleName: parsed.roleName,
          secretRef,
        },
        'asset.credential_added',
      );
      return toAssetCredentialView(row);
    });
  }

  /**
   * Replaces the secret of an existing role credential with a new version (SECRETS-012). The recipe and MFA type stay
   * as stored; the new secret set must still satisfy them. The rotation and the audit event (`asset.credential_rotated`)
   * are two steps: when the rotation landed but its audit cannot be written, the request fails (`500`), so an
   * unaudited rotation is never reported as done.
   */
  async rotate(
    principal: AssetPrincipal,
    assetId: string,
    roleName: string,
    body: unknown,
  ): Promise<AssetCredentialRotationView> {
    return inAssetSpan('credentials.rotate', async () => {
      const parsed = rotateAssetCredentialBodySchema.safeParse(body);
      if (!parsed.success) {
        throw invalidCredential(
          parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
        );
      }
      const current = await this.deps.assets.transact('credentials.rotate.read', async (tx) => {
        const asset = await this.authorisedAsset(tx, principal, assetId, 'update');
        const credential = await this.credentialOf(tx, principal.tenantId, asset.id, roleName);
        return { asset, credential };
      });
      const recipe = assetLoginRecipeSchema.parse(current.credential.loginRecipe);
      const missing = missingCredentialSecrets(
        recipe,
        current.credential.mfaType,
        parsed.data.secrets,
      );
      if (missing.length > 0) {
        throw new ValidationError('the rotated credential is missing required secrets', {
          detail: `Missing required fields: ${missing.join(', ')}.`,
        });
      }
      const ref = parseSecretRef(current.credential.secretRef);
      if (ref.tenantId !== principal.tenantId) throw new NotFoundError('credential not found');
      const version = await this.rotateSecret(
        principal.tenantId,
        ref.secretId,
        bundleOf(parsed.data.secrets),
      );
      const rotatedAt = new Date();
      await this.deps.assets.transact('credentials.rotate', async (tx) => {
        await this.authorisedAsset(tx, principal, current.asset.id, 'update');
        const touched = await this.deps.credentials.markRotated(
          tx,
          principal.tenantId,
          current.credential.id,
        );
        if (touched === undefined) throw new NotFoundError('credential not found');
        await this.audit.emitAuditInTx(
          auditSqlTx(tx),
          this.auditInput(principal, 'asset.credential_rotated', current.asset, {
            roleName,
            secretVersion: version,
          }),
        );
      });
      this.deps.logger.info(
        {
          assetId: current.asset.publicId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          roleName,
          secretRef: current.credential.secretRef,
          secretVersion: version,
        },
        'asset.credential_rotated',
      );
      return {
        roleName,
        secretRef: current.credential.secretRef,
        secretVersion: version,
        rotatedAt: rotatedAt.toISOString(),
      };
    });
  }

  /** The live asset of `assetId` after RBAC and the Cedar check for `operation`. */
  private async authorisedAsset(
    tx: TenantTx,
    principal: AssetPrincipal,
    assetId: string,
    operation: AssetOperation,
  ): Promise<AssetRow> {
    const roles = await memberRolesOf(this.deps.assets, tx, principal.userId);
    const id = rowIdOf(assetId);
    const row = id === undefined ? undefined : await this.deps.assets.findLive(tx, id);
    if (row === undefined) throw new NotFoundError('asset not found');
    this.authorise(principal, roles, operation, assetResource(row));
    return row;
  }

  private async credentialOf(
    tx: TenantTx,
    tenantId: string,
    assetId: string,
    roleName: string,
  ): Promise<AssetCredentialRow> {
    const row = await this.deps.credentials.findByRole(tx, tenantId, assetId, roleName);
    if (row === undefined) throw new NotFoundError('credential not found');
    return row;
  }

  private authorise(
    principal: AssetPrincipal,
    roles: readonly string[],
    operation: AssetOperation,
    resource: AssetPolicyResource,
  ): void {
    authoriseAsset(this.deps.policy, principal, roles, operation, resource);
  }

  /** Seals the bundle, or refuses with `503` and counts the failure. Nothing has been written at this point. */
  private async seal(tenantId: string, secretId: string, plaintext: string) {
    try {
      return await this.deps.vault.seal({ tenantId, secretId, plaintext });
    } catch {
      this.deps.metrics.credentialSecretWriteFailed();
      this.deps.logger.warn({ tenantId, secretId }, 'asset.credential_secret_write_failed');
      throw new AssetCredentialSecretWriteError();
    }
  }

  private async rotateSecret(
    tenantId: string,
    secretId: string,
    plaintext: string,
  ): Promise<number> {
    try {
      return await this.deps.vault.rotate({ tenantId, secretId, plaintext });
    } catch {
      this.deps.metrics.credentialSecretWriteFailed();
      this.deps.logger.warn({ tenantId, secretId }, 'asset.credential_secret_write_failed');
      throw new AssetCredentialSecretWriteError();
    }
  }

  private auditInput(
    caller: AssetCaller,
    action: AuditEventInput['action'],
    row: AssetRow,
    metadata: AuditEventInput['metadata'],
  ): AuditEventInput {
    return assetAuditInput(caller, action, row, metadata);
  }
}
