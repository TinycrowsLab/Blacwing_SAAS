import { redirect } from 'next/navigation';

import { PermissionDenied } from '@blackwing/ui';

import { AssetsView } from './_components/assets-view';
import { canReadAssets } from '../../../components/assets/asset-model';
import { getSession } from '../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * `/assets`: the asset inventory (ASSET list, #368). The session is checked on the server; a caller without
 * `asset:read` sees the permission-denied state and no list request is sent. The filters are read from the URL on the
 * client, so a filtered view is a link.
 */
export default async function AssetsPage(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login');
  if (!canReadAssets(session.roles)) return <PermissionDenied permission="asset:read" />;
  return <AssetsView roles={session.roles} ownerUserId={session.user.id} />;
}
