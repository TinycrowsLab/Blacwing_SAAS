import { notFound, redirect } from 'next/navigation';

import { uuidV7Schema } from '@blackwing/contracts';

import { KillControl } from '../../../../components/kill/kill-control';
import { canTriggerKill } from '../../../../components/kill/kill-model';
import { getSession } from '../../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * `/assets/[id]`: the asset's kill control (`asset` scope). Ids that are not UUIDs are a 404. The asset
 * page does not yet receive ownership, so an Asset Owner sees the control only once it does (fail closed).
 */
export default async function AssetPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  if (!uuidV7Schema.safeParse(id).success) notFound();
  const session = await getSession();
  if (session === null) redirect('/login');
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header className="grid gap-2">
        <h1 className="text-xl font-semibold">Asset</h1>
        <p className="font-mono text-xs text-muted-foreground">{id}</p>
      </header>
      {canTriggerKill(session.roles, { scope: 'asset' }) ? (
        <KillControl scope="asset" scopeRefId={id} roles={session.roles} />
      ) : (
        <p className="text-sm text-muted-foreground">You cannot stop testing on this asset.</p>
      )}
    </div>
  );
}
