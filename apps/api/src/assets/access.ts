import { trace } from '@opentelemetry/api';

import { isRole, ROLE_PERMISSIONS } from '@blackwing/contracts';
import { fromPublicId, type TenantTx } from '@blackwing/db';
import { ForbiddenError } from '@blackwing/errors';

import {
  ASSET_ACTIONS,
  type AssetAction,
  type AssetPolicyEngine,
  type AssetPolicyResource,
} from './policy.js';

import type { AssetRepository, AssetRow } from './repository.js';
import type { AuditEventInput } from '@blackwing/audit';

/**
 * Shared access rules of the asset API (ASSET-002, ASSET-003): who may act (RBAC: the caller's roles grant
 * permissions), on what (the Cedar resource check), and how the audit event of an action is shaped. The asset
 * lifecycle and the verification lifecycle both use these, so the two cannot disagree about authorisation.
 */

/** The operations of the asset API, one Cedar action each. */
export type AssetOperation = 'list' | 'read' | 'create' | 'update' | 'delete' | 'verify';

/** Who acts: a user of this tenant. `userId` is the user's row id (uuid), never a public id or an email. */
export interface AssetCaller {
  readonly tenantId: string;
  readonly userId: string;
}

const ACTION_ID: Record<AssetOperation, AssetAction> = {
  list: ASSET_ACTIONS.list,
  read: ASSET_ACTIONS.read,
  create: ASSET_ACTIONS.create,
  update: ASSET_ACTIONS.update,
  delete: ASSET_ACTIONS.delete,
  verify: ASSET_ACTIONS.verify,
};

/** The permissions a set of roles grants, from the role matrix. Unknown role names grant nothing. */
export function permissionsOf(roles: readonly string[]): string[] {
  const granted = new Set<string>();
  for (const role of roles) {
    if (!isRole(role)) continue;
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted].sort();
}

/** The Cedar resource of an asset row: its tenant and owner are what the policy compares. */
export function assetResource(row: AssetRow): AssetPolicyResource {
  return { kind: 'asset', id: row.id, tenantId: row.tenantId, ownerUserId: row.ownerUserId };
}

/** The roles of `userId` in this tenant. A non-member has none: `403`, and no data is read past this point. */
export async function memberRolesOf(
  repository: AssetRepository,
  tx: TenantTx,
  userId: string,
): Promise<readonly string[]> {
  const roles = await repository.rolesOf(tx, userId);
  if (roles === undefined) throw new ForbiddenError('not a member of this tenant');
  return roles;
}

/** RBAC first (the permission the roles grant), then the Cedar resource check. Deny unless both allow. */
export function authoriseAsset(
  policy: AssetPolicyEngine,
  caller: AssetCaller,
  roles: readonly string[],
  operation: AssetOperation,
  resource: AssetPolicyResource,
): void {
  const decision = policy.authorize(
    {
      userId: caller.userId,
      tenantId: caller.tenantId,
      roles,
      permissions: permissionsOf(roles),
    },
    ACTION_ID[operation],
    resource,
  );
  if (decision.decision !== 'allow')
    throw new ForbiddenError('the asset action is not permitted for this caller');
}

/** The audit event of an action on an asset. The actor is the caller's user row; the target is the asset. */
export function assetAuditInput(
  caller: AssetCaller,
  action: AuditEventInput['action'],
  row: AssetRow,
  metadata: AuditEventInput['metadata'],
): AuditEventInput {
  return {
    tenantId: caller.tenantId,
    action,
    actor: { type: 'user', id: caller.userId },
    target: { type: 'asset', id: row.id, publicId: row.publicId },
    outcome: 'success',
    ...(metadata === undefined ? {} : { metadata }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The row uuid behind a path id: the uuid itself, or the `asset_…` public id. Anything else is not an asset
 * (answered as 404, the same as another tenant's id).
 */
export function rowIdOf(value: string): string | undefined {
  if (UUID.test(value)) return value.toLowerCase();
  try {
    return fromPublicId(value, 'asset');
  } catch {
    return undefined;
  }
}

/** Runs `fn` in an `assets.<operation>` span (the span names of the asset API). */
export function inAssetSpan<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer('@blackwing/api').startActiveSpan(`assets.${operation}`, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}
