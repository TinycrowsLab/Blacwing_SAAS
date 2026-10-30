import { fromPublicId } from '@blackwing/db';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';
import { ForbiddenError } from '@blackwing/errors';

import type { AssetPrincipal } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The caller's row id. A user is identified by their user row (uuid) or its `usr_` public id; anything else is refused. */
function userRowIdOf(actorId: string): string {
  if (UUID.test(actorId)) return actorId;
  try {
    return fromPublicId(actorId, 'usr');
  } catch {
    throw new ForbiddenError('the caller identity is not a user of this tenant');
  }
}

/** The tenant and user of this request, from the context the tenant guard resolved (never from the body). */
export function principalOfRequest(): AssetPrincipal {
  const { tenantId, actor } = getTenantContextOrThrow();
  if (actor.type !== 'user') throw new ForbiddenError('asset management needs a user principal');
  return { tenantId, userId: userRowIdOf(actor.id) };
}
