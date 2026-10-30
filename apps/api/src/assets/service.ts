import { createHash } from 'node:crypto';

import { and, inArray, sql } from 'drizzle-orm';

import { type AuditEmitter, type AuditEventInput, createAuditEmitter } from '@blackwing/audit';
import {
  type AssetListResponse,
  type AssetView,
  type CreateAssetBody,
  type ListAssetsQuery,
  type UpdateAssetBody,
  idempotencyKeySchema,
} from '@blackwing/contracts';
import { type AssetListPage, publicId, standingAuthorisations, type TenantTx } from '@blackwing/db';
import {
  AppError,
  NotFoundError,
  PreconditionRequiredError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  assetAuditInput,
  assetResource,
  authoriseAsset,
  inAssetSpan,
  type AssetCaller,
  type AssetOperation,
  memberRolesOf,
  rowIdOf,
} from './access.js';
import { auditSqlTx } from './audit-tx.js';
import { AssetInUseError, AssetStaleWriteError } from './errors.js';
import { normaliseIdentifiers } from './identifiers.js';
import { canonicalize, parseIfMatch, versionEtag, type IfMatch } from '../concurrency/index.js';

import type { AssetMetrics } from './metrics.js';
import type { AssetPolicyEngine, AssetPolicyResource } from './policy.js';
import type { AssetPatch, AssetRepository, AssetRow } from './repository.js';
import type { Logger } from '@blackwing/logger';

/** Who acts: a user of this tenant. `userId` is the user's row id (uuid), never a public id or an email. */
export interface AssetPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

/** The result of a create: `201` for a new asset, `200` for a replay of an earlier request with the same key. */
export interface AssetCreateResult {
  readonly status: typeof HTTP_OK | typeof HTTP_CREATED;
  readonly view: AssetView;
}

/**
 * Answers "is this asset still in use?" before a delete (ASSET-002: `409 ASSET_IN_USE`). Standing
 * authorisations are the references that exist today; a run names its assets through its standing
 * authorisation, so one check covers both.
 */
export interface AssetReferenceReader {
  isReferenced(tx: TenantTx, assetId: string): Promise<boolean>;
}

/**
 * The live reference check: an authorisation that covers the asset and is still pending or active. Revoked,
 * expired and draft authorisations do not block a delete.
 */
const standingAuthorisationReferences: AssetReferenceReader = {
  async isReferenced(tx, assetId) {
    const rows = await tx
      .select({ id: standingAuthorisations.id })
      .from(standingAuthorisations)
      .where(
        and(
          sql`${assetId}::uuid = ANY(${standingAuthorisations.assetIds})`,
          inArray(standingAuthorisations.status, ['pending_approval', 'active']),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },
};

/** The paged asset list read: the projection the scoping wizard renders (`AssetRepository.page` of @blackwing/db). */
export interface AssetProjectionReader {
  page(tenantId: string, query: ListAssetsQuery, limit: number): Promise<AssetListPage>;
}

export interface AssetServiceDeps {
  readonly repository: AssetRepository;
  readonly projections: AssetProjectionReader;
  readonly policy: AssetPolicyEngine;
  readonly audit?: AuditEmitter;
  readonly references?: AssetReferenceReader;
  readonly metrics: AssetMetrics;
  readonly logger: Pick<Logger, 'info'>;
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;

/** SHA-256 of the canonical create body: equal requests fingerprint equal, a changed body does not. */
function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Maps a parsed `If-Match` to the current ETag: `*` matches any existing row, a list must name it. */
function assertEtagMatches(parsed: IfMatch, stateVersion: number, metrics: AssetMetrics): void {
  if (parsed.kind === 'any') return;
  if (parsed.etags.includes(versionEtag(stateVersion))) return;
  metrics.writeConflict();
  throw new AssetStaleWriteError();
}

function requireIfMatch(header: string | undefined): IfMatch {
  const parsed = parseIfMatch(header);
  if (parsed === undefined)
    throw new PreconditionRequiredError('This resource requires an If-Match header.');
  return parsed;
}

/** The view a client sees. The public id is the only identifier that leaves the service. */
function toAssetView(row: AssetRow, warnings: readonly string[] = []): AssetView {
  return {
    id: row.id,
    publicId: row.publicId,
    type: row.type,
    name: row.name,
    identifiers: row.identifiers.map((identifier) => ({ ...identifier })),
    environment: row.environment,
    ownerUserId: row.ownerUserId,
    verificationStatus: row.verificationStatus,
    verificationMethod: row.verificationMethod,
    etag: versionEtag(row.stateVersion),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    warnings: [...warnings],
  };
}

/**
 * Asset lifecycle (ASSET-002, #355): create, get, list, update and soft-delete. Each operation runs in one
 * tenant transaction: the authorisation decision, the write and its audit event commit together or not at
 * all (§8.6, §8.8). Authorisation is the RBAC permission (from the caller's membership roles) and then the
 * Cedar resource check. A foreign-tenant id is `404`, a same-tenant caller without the permission is `403`.
 */
export class AssetService {
  private readonly audit: AuditEmitter;
  private readonly references: AssetReferenceReader;

  constructor(private readonly deps: AssetServiceDeps) {
    this.audit = deps.audit ?? createAuditEmitter();
    this.references = deps.references ?? standingAuthorisationReferences;
  }

  async create(
    principal: AssetPrincipal,
    body: CreateAssetBody,
    idempotencyKey: string | undefined,
  ): Promise<AssetCreateResult> {
    const key = parseIdempotencyKey(idempotencyKey);
    const { identifiers, warnings } = normaliseIdentifiers(body.type, body.identifiers);
    const fingerprint = fingerprintOf({
      type: body.type,
      name: body.name,
      identifiers,
      environment: body.environment,
      ownerUserId: body.ownerUserId,
    });
    return this.withSpan('create', () =>
      this.deps.repository.transact('create', async (tx) => {
        const roles = await this.memberRoles(tx, principal.userId);
        this.authorise(principal, roles, 'create', {
          kind: 'tenant',
          tenantId: principal.tenantId,
        });
        if (key !== null) {
          const replay = await this.replayOf(tx, key, fingerprint);
          if (replay !== undefined) return replay;
        }
        await this.assertMember(tx, body.ownerUserId);
        const id = newId();
        const row = await this.deps.repository.insert(tx, principal.tenantId, {
          id,
          publicId: publicId('asset', id),
          type: body.type,
          name: body.name,
          identifiers,
          environment: body.environment,
          ownerUserId: body.ownerUserId,
          idempotencyKey: key,
          idempotencyFingerprint: key === null ? null : fingerprint,
        });
        if (row === undefined) {
          // A concurrent request with the same key won the unique index: answer with its asset.
          const replay = key === null ? undefined : await this.replayOf(tx, key, fingerprint);
          if (replay !== undefined) return replay;
          throw new AppError('INTERNAL', 'asset insert produced no row');
        }
        await this.audit.emitAuditInTx(
          auditSqlTx(tx),
          this.auditInput(principal, 'asset.created', row, {
            assetType: row.type,
            environment: row.environment,
            identifierCount: row.identifiers.length,
          }),
        );
        this.deps.logger.info(
          { assetId: row.publicId, tenantId: principal.tenantId, actorId: principal.userId },
          'asset.created',
        );
        return { status: HTTP_CREATED, view: toAssetView(row, warnings) };
      }),
    );
  }

  async get(principal: AssetPrincipal, assetId: string): Promise<AssetView> {
    return this.withSpan('get', () =>
      this.deps.repository.transact('get', async (tx) => {
        const roles = await this.memberRoles(tx, principal.userId);
        const row = await this.liveAsset(tx, assetId);
        this.authorise(principal, roles, 'read', assetResource(row));
        return toAssetView(row);
      }),
    );
  }

  /**
   * One page of the tenant's live assets for the wizard and other readers (#355, ASSET-017). The authorisation is
   * the same as for every read: the caller's roles (RBAC) and the Cedar tenant check. The page is the projection, so
   * no identifier, credential or attestation leaves through the list.
   */
  async list(
    principal: AssetPrincipal,
    query: ListAssetsQuery,
    limit: number,
  ): Promise<AssetListResponse> {
    return this.withSpan('list', async () => {
      const roles = await this.deps.repository.transact('list', (tx) =>
        this.memberRoles(tx, principal.userId),
      );
      this.authorise(principal, roles, 'list', { kind: 'tenant', tenantId: principal.tenantId });
      const page = await this.deps.projections.page(principal.tenantId, query, limit);
      return {
        items: [...page.items],
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      };
    });
  }

  async update(
    principal: AssetPrincipal,
    assetId: string,
    body: UpdateAssetBody,
    ifMatch: string | undefined,
  ): Promise<AssetView> {
    const precondition = requireIfMatch(ifMatch);
    return this.withSpan('update', () =>
      this.deps.repository.transact('update', async (tx) => {
        const roles = await this.memberRoles(tx, principal.userId);
        const row = await this.liveAsset(tx, assetId);
        this.authorise(principal, roles, 'update', assetResource(row));
        assertEtagMatches(precondition, row.stateVersion, this.deps.metrics);

        const patch: AssetPatch = {};
        const changed: string[] = [];
        if (body.name !== undefined && body.name !== row.name) {
          patch.name = body.name;
          changed.push('name');
        }
        if (body.environment !== undefined && body.environment !== row.environment) {
          patch.environment = body.environment;
          changed.push('environment');
        }
        let warnings: string[] = [];
        if (body.identifiers !== undefined) {
          const normalised = normaliseIdentifiers(row.type, body.identifiers);
          warnings = normalised.warnings;
          if (canonicalize(normalised.identifiers) !== canonicalize(row.identifiers)) {
            patch.identifiers = normalised.identifiers;
            changed.push('identifiers');
          }
        }
        const ownerChanged = body.ownerUserId !== undefined && body.ownerUserId !== row.ownerUserId;
        if (body.ownerUserId !== undefined && ownerChanged) {
          await this.assertMember(tx, body.ownerUserId);
          patch.ownerUserId = body.ownerUserId;
          changed.push('ownerUserId');
        }
        if (changed.length === 0) return toAssetView(row, warnings);

        const updated = await this.deps.repository.updateIfVersion(
          tx,
          row.id,
          row.stateVersion,
          patch,
        );
        if (updated === undefined) {
          this.deps.metrics.writeConflict();
          throw new AssetStaleWriteError();
        }
        await this.audit.emitAuditInTx(
          auditSqlTx(tx),
          this.auditInput(principal, 'asset.updated', updated, { changedFields: changed }),
        );
        if (ownerChanged) {
          await this.audit.emitAuditInTx(
            auditSqlTx(tx),
            this.auditInput(principal, 'asset.owner_assigned', updated, {
              ownerUserId: updated.ownerUserId,
            }),
          );
        }
        this.deps.logger.info(
          {
            assetId: updated.publicId,
            tenantId: principal.tenantId,
            actorId: principal.userId,
            changedFields: changed,
          },
          'asset.updated',
        );
        return toAssetView(updated, warnings);
      }),
    );
  }

  async remove(
    principal: AssetPrincipal,
    assetId: string,
    ifMatch: string | undefined,
  ): Promise<AssetView> {
    const precondition = ifMatch === undefined ? undefined : parseIfMatch(ifMatch);
    return this.withSpan('delete', () =>
      this.deps.repository.transact('delete', async (tx) => {
        const roles = await this.memberRoles(tx, principal.userId);
        const row = await this.liveAsset(tx, assetId);
        this.authorise(principal, roles, 'delete', assetResource(row));
        if (precondition !== undefined)
          assertEtagMatches(precondition, row.stateVersion, this.deps.metrics);
        if (await this.references.isReferenced(tx, row.id)) throw new AssetInUseError();
        const deleted = await this.deps.repository.softDeleteIfVersion(
          tx,
          row.id,
          row.stateVersion,
        );
        if (deleted === undefined) {
          this.deps.metrics.writeConflict();
          throw new AssetStaleWriteError();
        }
        await this.audit.emitAuditInTx(
          auditSqlTx(tx),
          this.auditInput(principal, 'asset.deleted', deleted, {}),
        );
        this.deps.logger.info(
          { assetId: deleted.publicId, tenantId: principal.tenantId, actorId: principal.userId },
          'asset.deleted',
        );
        return toAssetView(deleted);
      }),
    );
  }

  /** The asset with this public id, live in the tenant, or 404. The same answer for another tenant's id. */
  private async liveAsset(tx: TenantTx, publicAssetId: string): Promise<AssetRow> {
    const id = rowIdOf(publicAssetId);
    const row = id === undefined ? undefined : await this.deps.repository.findLive(tx, id);
    if (row === undefined) throw new NotFoundError('asset not found');
    return row;
  }

  /** The caller's roles in this tenant (see `memberRolesOf`). */
  private async memberRoles(tx: TenantTx, userId: string): Promise<readonly string[]> {
    return memberRolesOf(this.deps.repository, tx, userId);
  }

  /** An owner must be a member of the same tenant (RLS makes any other user invisible here). */
  private async assertMember(tx: TenantTx, userId: string): Promise<void> {
    const roles = await this.deps.repository.rolesOf(tx, userId);
    if (roles === undefined)
      throw new ValidationError('ownerUserId must be a member of this tenant', {
        detail: 'ownerUserId must be a member of this tenant.',
      });
  }

  /** RBAC first (the permission), then the Cedar resource check (see `authoriseAsset`). */
  private authorise(
    principal: AssetPrincipal,
    roles: readonly string[],
    action: AssetOperation,
    resource: AssetPolicyResource,
  ): void {
    authoriseAsset(this.deps.policy, principal, roles, action, resource);
  }

  private async replayOf(
    tx: TenantTx,
    key: string,
    fingerprint: string,
  ): Promise<AssetCreateResult | undefined> {
    const existing = await this.deps.repository.findByIdempotencyKey(tx, key);
    if (existing === undefined) return undefined;
    if (existing.idempotencyFingerprint !== fingerprint)
      throw new AppError(
        'IDEMPOTENCY_KEY_MISMATCH',
        'Idempotency-Key was used with a different request',
        {
          detail: 'This Idempotency-Key was already used for a different request.',
        },
      );
    return { status: HTTP_OK, view: toAssetView(existing) };
  }

  private auditInput(
    principal: AssetCaller,
    action: AuditEventInput['action'],
    row: AssetRow,
    metadata: AuditEventInput['metadata'],
  ): AuditEventInput {
    return assetAuditInput(principal, action, row, metadata);
  }

  private withSpan<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return inAssetSpan(operation, fn);
  }
}

function parseIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success)
    throw new ValidationError('Idempotency-Key is not valid', {
      detail: 'Idempotency-Key is not valid.',
    });
  return parsed.data;
}
