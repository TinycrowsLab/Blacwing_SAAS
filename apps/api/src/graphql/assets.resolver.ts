import { Inject, Optional, UseInterceptors } from '@nestjs/common';
import { Args, Context, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';

import {
  assetEnvironmentSchema,
  assetTypeSchema,
  LIMITS,
  verificationStatusSchema,
} from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import {
  AppError,
  ForbiddenError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';

import {
  AssetFilterModel,
  AssetGroupModel,
  AssetModel,
  AssetPageModel,
  AssetTagModel,
  type AttestationSummaryModel,
  CredentialRoleModel,
  VerificationStatusModel,
} from './assets.models.js';
import { UserModel } from './models.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './page.js';
import { ParamTypes } from './param-types.js';
import { GRAPHQL_ASSETS } from './tokens.js';
import { GraphqlTraceInterceptor } from './trace.interceptor.js';
import {
  ASSET_ACTIONS,
  type AssetPolicyResource,
  createCedarAssetPolicy,
} from '../assets/policy.js';
import { permissionsOf } from '../assets/service.js';
import { tenantContextOf } from '../tenant/guard.js';

import type { GraphqlResolverContext } from './members.resolver.js';
import type { AssetFilter, AssetPosition, AssetReadStore, AssetRow } from './store.js';

const UUID = z.uuid();
/** An asset reference: its uuid, or its `asset_` public id (the registry accepts either form). */
/** The shortest `asset_` public id: the prefix and at least one body character. */
const PUBLIC_ID_MIN_LENGTH = 7;
const ASSET_REF = z.union([
  UUID,
  z
    .string()
    .regex(/^asset_[A-Za-z0-9_-]+$/)
    .min(PUBLIC_ID_MIN_LENGTH),
]);
/** The opaque cursor: the keyset position of the last row of the previous page, base64url-encoded JSON. */
const CURSOR = z.object({ c: z.iso.datetime(), i: UUID });

/** The Cedar policy that decides a read, parsed once at import (a malformed policy set fails the boot). */
const assetPolicy = createCedarAssetPolicy();

/** Who asks, and in which tenant. */
interface Viewer {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Encodes the keyset position of the last row of a page. */
function encodeCursor(row: AssetRow): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }),
    'utf8',
  ).toString('base64url');
}

/** Decodes a cursor, or refuses it: a cursor that is not ours is a validation error, never a silent first page. */
function decodeCursor(cursor: string): AssetPosition {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('cursor is not valid');
  }
  const parsed = CURSOR.safeParse(raw);
  if (!parsed.success) throw new ValidationError('cursor is not valid');
  return { createdAt: new Date(parsed.data.c), id: parsed.data.i };
}

/** Parses one optional enum filter; an unknown value is refused, never dropped. */
function enumFilter<S extends z.ZodType<string>>(
  value: string | null | undefined,
  schema: S,
  name: string,
): z.output<S> | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`${name} is not a known value`);
  return parsed.data;
}

/** One optional free-text filter: 1 to `max` characters once trimmed, or refused (never silently dropped). */
function textFilter(
  value: string | null | undefined,
  max: number,
  name: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ValidationError(`${name} must be 1 to ${String(max)} characters`);
  }
  return trimmed;
}

/** The filter of the list, validated against the contracts. */
function filterOf(filter: AssetFilterModel | undefined): AssetFilter {
  const verificationStatus = enumFilter(
    filter?.verificationStatus,
    verificationStatusSchema,
    'verificationStatus',
  );
  const type = enumFilter(filter?.type, assetTypeSchema, 'type');
  const environment = enumFilter(filter?.environment, assetEnvironmentSchema, 'environment');
  const tagKey = textFilter(filter?.tagKey, LIMITS.keyMax, 'tagKey');
  const tagValue = textFilter(filter?.tagValue, LIMITS.labelMax, 'tagValue');
  if (tagValue !== undefined && tagKey === undefined) {
    throw new ValidationError('tagValue needs a tagKey');
  }
  const group = textFilter(filter?.group, LIMITS.labelMax, 'group');
  return {
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
    ...(type === undefined ? {} : { type }),
    ...(environment === undefined ? {} : { environment }),
    ...(tagKey === undefined ? {} : { tagKey }),
    ...(tagValue === undefined ? {} : { tagValue }),
    ...(group === undefined ? {} : { group }),
  };
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * The attestation summary: the declared environment type and the attested key names. The values are not copied, so
 * a secret written into the attestation can never reach GraphQL (§8.7).
 */
function attestationOf(
  attestation: Readonly<Record<string, unknown>> | null,
): AttestationSummaryModel | null {
  if (attestation === null) return null;
  const environmentType = attestation.environmentType;
  return {
    environmentType: typeof environmentType === 'string' ? environmentType : null,
    attestedKeys: Object.keys(attestation),
  };
}

/** The verification state of a row. */
function verificationOf(row: AssetRow): VerificationStatusModel {
  return {
    status: row.verificationStatus,
    method: row.verificationMethod,
    verifiedAt: iso(row.verifiedAt),
    expiresAt: iso(row.verificationExpiresAt),
  };
}

/** Converts a store row to the GraphQL type. Dates are ISO-8601 UTC; the owner id keys the `owner` field. */
function toModel(row: AssetRow): AssetModel {
  return {
    id: row.id,
    publicId: row.publicId,
    name: row.name,
    type: row.type,
    environment: row.environment,
    verification: verificationOf(row),
    attestation: attestationOf(row.attestation),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ownerUserId: row.ownerUserId,
  };
}

/** The tenant of the request, as the entry guard resolved it. Fails closed when there is none. */
function tenantIdOf(context: GraphqlResolverContext): string {
  if (context.req === undefined)
    throw new TenantContextMissingError('no request on the GraphQL context');
  const resolved = tenantContextOf(context.req);
  if (resolved === undefined)
    throw new TenantContextMissingError('tenant context was not resolved');
  return resolved.tenantId;
}

/**
 * Read resolvers of the asset read model (ASSET read API, API-009): the caller tenant's assets as a keyset page, and
 * one asset, or its verification, by id. Read-only: writes stay on REST. Authorisation is the `asset:read` permission
 * of the caller's roles (RBAC), then the Cedar read check. A foreign, missing or deleted id answers `null`, so existence
 * does not leak. The nested owner, tags, groups and credential roles are batched through DataLoaders.
 */
@Resolver(() => AssetModel)
@UseInterceptors(GraphqlTraceInterceptor)
export class AssetsResolver {
  constructor(
    @Optional()
    @Inject(GRAPHQL_ASSETS)
    private readonly store: AssetReadStore | null = null,
  ) {}

  /** Assets of the caller's tenant, newest first. `limit` is clamped to the platform maximum; `cursor` is the last one. */
  @Query(() => AssetPageModel, {
    description: 'Assets of the caller tenant (keyset page, newest first).',
  })
  @ParamTypes(Object, AssetFilterModel, String, Number)
  async assets(
    @Context() context: GraphqlResolverContext,
    @Args('filter', { type: () => AssetFilterModel, nullable: true }) filter?: AssetFilterModel,
    @Args('cursor', { type: () => String, nullable: true }) cursor?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<AssetPageModel> {
    const store = this.storeOf();
    const size = limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw new ValidationError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
    const parsedFilter = filterOf(filter);
    const viewer = await this.authorise(context, 'list');
    const rows = await store.listAssets(viewer.tenantId, {
      filter: parsedFilter,
      ...(cursor === undefined ? {} : { after: decodeCursor(cursor) }),
      limit: size + 1,
    });
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      items: page.map((row) => toModel(row)),
      nextCursor: rows.length > size && last !== undefined ? encodeCursor(last) : null,
      hasMore: rows.length > size,
    };
  }

  /** One asset of the caller's tenant, or `null` when it is missing, foreign or deleted. */
  @Query(() => AssetModel, {
    nullable: true,
    description: 'One asset of the caller tenant (uuid or asset_ public id), or null.',
  })
  @ParamTypes(Object, String)
  async asset(
    @Context() context: GraphqlResolverContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AssetModel | null> {
    const row = await this.readRow(context, id);
    return row === undefined ? null : toModel(row);
  }

  /** The verification of one asset of the caller's tenant, or `null` under the same rules as {@link asset}. */
  @Query(() => VerificationStatusModel, {
    nullable: true,
    description: 'Ownership verification state of one asset of the caller tenant, or null.',
  })
  @ParamTypes(Object, String)
  async assetVerification(
    @Context() context: GraphqlResolverContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<VerificationStatusModel | null> {
    const row = await this.readRow(context, id);
    return row === undefined ? null : verificationOf(row);
  }

  /** The owner, through the membership-scoped user loader: a lapsed owner (no membership) resolves to `null`. */
  @ResolveField(() => UserModel, { nullable: true })
  async owner(
    @Parent() asset: AssetModel,
    @Context() context: GraphqlResolverContext,
  ): Promise<UserModel | null> {
    const row = await context.loaders.users.load({
      tenantId: tenantIdOf(context),
      id: asset.ownerUserId,
    });
    return row === undefined ? null : { id: row.id, name: row.name, email: row.email };
  }

  /** The labels of the asset, batched with the other assets of the same response. */
  @ResolveField(() => [AssetTagModel])
  async tags(
    @Parent() asset: AssetModel,
    @Context() context: GraphqlResolverContext,
  ): Promise<AssetTagModel[]> {
    const rows = await context.loaders.assetTags.load({
      tenantId: tenantIdOf(context),
      id: asset.id,
    });
    return (rows ?? []).map((row) => ({ key: row.key, value: row.value }));
  }

  /** The groups the asset is a member of, batched with the other assets of the same response. */
  @ResolveField(() => [AssetGroupModel])
  async groups(
    @Parent() asset: AssetModel,
    @Context() context: GraphqlResolverContext,
  ): Promise<AssetGroupModel[]> {
    const rows = await context.loaders.assetGroups.load({
      tenantId: tenantIdOf(context),
      id: asset.id,
    });
    return (rows ?? []).map((row) => ({ id: row.id, name: row.name }));
  }

  /** The credential roles of the asset: role, MFA type and secret reference. Never a secret value. */
  @ResolveField(() => [CredentialRoleModel])
  async credentialRoles(
    @Parent() asset: AssetModel,
    @Context() context: GraphqlResolverContext,
  ): Promise<CredentialRoleModel[]> {
    const rows = await context.loaders.assetCredentialRoles.load({
      tenantId: tenantIdOf(context),
      id: asset.id,
    });
    return (rows ?? []).map((row) => ({
      roleName: row.roleName,
      mfaType: row.mfaType,
      secretRef: row.secretRef,
    }));
  }

  /** One asset row the caller may read, or `undefined` (missing, foreign, deleted, or a malformed reference). */
  private async readRow(
    context: GraphqlResolverContext,
    ref: string,
  ): Promise<AssetRow | undefined> {
    const store = this.storeOf();
    if (!ASSET_REF.safeParse(ref).success) return undefined;
    const viewer = await this.authorise(context, 'read');
    const row = await store.findAsset(viewer.tenantId, ref);
    if (row === undefined) return undefined;
    this.authoriseRead(viewer, row);
    return row;
  }

  /** The Cedar read check for one row: same tenant, and the asset's owner is recorded (the policy is tenant-scoped). */
  private authoriseRead(viewer: Viewer, row: AssetRow): void {
    const decision = assetPolicy.authorize(
      {
        userId: viewer.userId,
        tenantId: viewer.tenantId,
        roles: viewer.roles,
        permissions: permissionsOf(viewer.roles),
      },
      ASSET_ACTIONS.read,
      { kind: 'asset', id: row.id, tenantId: row.tenantId, ownerUserId: row.ownerUserId },
    );
    if (decision.decision !== 'allow') {
      throw new ForbiddenError('the caller may not read this asset', {
        detail: 'Missing permission asset:read in this tenant.',
      });
    }
  }

  /** The store, or the `GRAPH_QUERY_UNAVAILABLE` refusal when assets are not configured (fail closed). */
  private storeOf(): AssetReadStore {
    if (this.store === null)
      throw new AppError('GRAPH_QUERY_UNAVAILABLE', 'assets are not configured');
    return this.store;
  }

  /**
   * The caller, from the tenant the guard resolved. RBAC first (`asset:read`, from the caller's roles in the tenant);
   * an unknown user holds no roles. The list also passes the Cedar tenant check for `resource`.
   */
  private async authorise(
    context: GraphqlResolverContext,
    action: 'list' | 'read',
    resource?: AssetPolicyResource,
  ): Promise<Viewer> {
    if (context.req === undefined)
      throw new TenantContextMissingError('no request on the GraphQL context');
    const resolved = tenantContextOf(context.req);
    if (resolved === undefined)
      throw new TenantContextMissingError('tenant context was not resolved');
    const { tenantId, actor } = resolved;
    const store = this.storeOf();
    const roles = UUID.safeParse(actor.id).success ? await store.rolesOf(tenantId, actor.id) : [];
    if (!hasPermission(roles, 'asset:read')) {
      throw new ForbiddenError('the caller may not read assets', {
        detail: 'Missing permission asset:read in this tenant.',
      });
    }
    const viewer: Viewer = { tenantId, userId: actor.id, roles };
    if (action === 'list') {
      const decision = assetPolicy.authorize(
        { userId: viewer.userId, tenantId, roles, permissions: permissionsOf(roles) },
        ASSET_ACTIONS.list,
        resource ?? { kind: 'tenant', tenantId },
      );
      if (decision.decision !== 'allow') {
        throw new ForbiddenError('the caller may not list assets');
      }
    }
    return viewer;
  }
}
