// Targets (experience spec §2): the workspace's sites, with Add target and on-demand verification.
import { z } from 'zod';

import { InlineMessage } from '../../../components/console/design';
import { Targets } from '../../../components/console/order/targets';
import { callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { assetSchema } from '../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Targets' };

const listSchema = z.object({ items: z.array(assetSchema) });

export default async function TargetsPage(): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const items = await callApi(session, '/assets')
    .then((b) => listSchema.parse(b).items)
    .catch(() => null);
  if (items === null)
    return (
      <div className="mx-auto w-full max-w-[920px]">
        <InlineMessage tone="bad">We couldn&apos;t load your targets. Reload the page to try again.</InlineMessage>
      </div>
    );
  return <Targets initial={items} viewerName={session.user.name} />;
}
