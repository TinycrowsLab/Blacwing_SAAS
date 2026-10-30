import type { CedarValueJson, EntityJson } from '@cedar-policy/cedar-wasm/nodejs';

/** The resource-level actions the baseline knows (`schema/authz.cedarschema`). */
export const AUTHZ_ACTIONS = [
  'asset:read',
  'asset:write',
  'sa:approve',
  'run:read',
  'finding:read',
] as const;
export type AuthzAction = (typeof AUTHZ_ACTIONS)[number];

/** A human caller. `roles` are RBAC role names (`@blackwing/contracts` ROLES). */
export interface UserPrincipal {
  readonly kind: 'user';
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** A service account. `scopes` are the actions it was granted; `assetIds` bound its asset scope. */
export interface ServiceAccountPrincipal {
  readonly kind: 'service_account';
  readonly tenantId: string;
  readonly saId: string;
  readonly scopes: readonly string[];
  readonly assetIds: readonly string[];
}

export type AuthzPrincipal = UserPrincipal | ServiceAccountPrincipal;

/** The resource being acted on, as loaded from the domain. Every variant carries its tenant. */
export type AuthzResource =
  | {
      readonly kind: 'asset';
      readonly tenantId: string;
      readonly assetId: string;
      readonly ownerUserId: string;
    }
  | {
      readonly kind: 'standing_authorisation';
      readonly tenantId: string;
      readonly saId: string;
      readonly requesterId: string;
      /** The owners of every asset the SA covers, de-duplicated. */
      readonly assetOwnerIds: readonly string[];
    }
  | {
      readonly kind: 'run';
      readonly tenantId: string;
      readonly runId: string;
      readonly ownerUserId: string;
    }
  | {
      readonly kind: 'finding';
      readonly tenantId: string;
      readonly findingId: string;
      readonly ownerUserId: string;
    };

/** The Cedar request for one decision: principal, action and resource UIDs plus their entities. */
export interface CedarRequest {
  readonly principal: { readonly type: string; readonly id: string };
  readonly action: { readonly type: 'Action'; readonly id: AuthzAction };
  readonly resource: { readonly type: string; readonly id: string };
  readonly entities: readonly EntityJson[];
}

/**
 * Builds the Cedar request from typed domain values. Attribute names match
 * `schema/authz.cedarschema`; a `kind` the schema does not know cannot be built, because the
 * `switch` is exhaustive over the union.
 */
export function toCedarRequest(
  principal: AuthzPrincipal,
  action: AuthzAction,
  resource: AuthzResource,
): CedarRequest {
  const principalUid =
    principal.kind === 'user'
      ? { type: 'User', id: principal.userId }
      : { type: 'ServiceAccount', id: principal.saId };
  const principalAttrs: Record<string, CedarValueJson> =
    principal.kind === 'user'
      ? {
          tenantId: principal.tenantId,
          userId: principal.userId,
          roles: [...principal.roles],
        }
      : {
          tenantId: principal.tenantId,
          saId: principal.saId,
          scopes: [...principal.scopes],
          assetIds: [...principal.assetIds],
        };

  let resourceUid: { type: string; id: string };
  let resourceAttrs: Record<string, CedarValueJson>;
  switch (resource.kind) {
    case 'asset':
      resourceUid = { type: 'Asset', id: resource.assetId };
      resourceAttrs = {
        tenantId: resource.tenantId,
        assetId: resource.assetId,
        ownerUserId: resource.ownerUserId,
      };
      break;
    case 'standing_authorisation':
      resourceUid = { type: 'StandingAuthorisation', id: resource.saId };
      resourceAttrs = {
        tenantId: resource.tenantId,
        saId: resource.saId,
        requesterId: resource.requesterId,
        assetOwnerIds: [...resource.assetOwnerIds],
      };
      break;
    case 'run':
      resourceUid = { type: 'Run', id: resource.runId };
      resourceAttrs = {
        tenantId: resource.tenantId,
        runId: resource.runId,
        ownerUserId: resource.ownerUserId,
      };
      break;
    case 'finding':
      resourceUid = { type: 'Finding', id: resource.findingId };
      resourceAttrs = {
        tenantId: resource.tenantId,
        findingId: resource.findingId,
        ownerUserId: resource.ownerUserId,
      };
      break;
  }

  return {
    principal: principalUid,
    action: { type: 'Action', id: action },
    resource: resourceUid,
    entities: [
      { uid: principalUid, attrs: principalAttrs, parents: [] },
      { uid: resourceUid, attrs: resourceAttrs, parents: [] },
    ],
  };
}
