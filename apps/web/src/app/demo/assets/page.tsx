// DEMO-STORY assets: the lab target and its ownership state. Ownership is verified by lab trust (demo stub).
import Link from 'next/link';
import { z } from 'zod';

import { StatusPill } from '../../../components/demo/status-pill';
import { demoApi } from '../_lib/demo-api';
import { assetSchema } from '../_lib/schemas';
import { getSession } from '../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const listSchema = z.object({ items: z.array(assetSchema) });

export default async function DemoAssetsPage(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { items } = listSchema.parse(await demoApi(session, '/assets'));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Assets</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        The lab asset is the local Juice Shop. Its ownership is verified by lab trust (a demo stub: no DNS or HTTP proof).
        Only verified assets can be assessed, and the demo refuses anything that is not a loopback lab target.
      </p>
      <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {items.map((asset) => (
          <li key={asset.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="space-y-1">
              <p className="font-medium">{asset.name}</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                <code>{asset.baseUrl}</code> · ownership <StatusPill value={asset.ownership.status} /> · {asset.ownership.basis}
              </p>
            </div>
            <Link
              className="rounded border border-neutral-400 px-3 py-1 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
              href={`/demo/requests/new?assetId=${encodeURIComponent(asset.id)}`}
            >
              Request assessment
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
