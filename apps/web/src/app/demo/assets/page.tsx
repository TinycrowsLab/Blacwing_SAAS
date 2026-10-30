// DEMO-STORY assets: the lab target and its ownership state. Ownership is verified by lab trust (demo stub).
import { z } from 'zod';

import {
  DataTable,
  Icon,
  IdChip,
  LinkButton,
  PageHeader,
  StatusChip,
} from '../../../components/demo/design';
import { ContextPanel } from '../../../components/demo/shell';
import { getSession } from '../../../lib/session';
import { demoApi } from '../_lib/demo-api';
import { assetSchema } from '../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const listSchema = z.object({ items: z.array(assetSchema) });

export default async function DemoAssetsPage(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { items } = listSchema.parse(await demoApi(session, '/assets'));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Assets' }]}
        title="Assets"
        chips={
          <span className="text-[13px] text-muted-foreground">{items.length} in this tenant</span>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-4">
          <p className="max-w-3xl text-[13.5px] leading-6 text-muted-foreground">
            The lab asset is the local Juice Shop. Its ownership is verified by lab trust (a demo
            stub: no DNS or HTTP proof). Only verified assets can be assessed, and the demo refuses
            anything that is not a loopback lab target.
          </p>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <DataTable label="Assets" head={['Asset', 'Base URL', 'Ownership', 'Environment', '']}>
              {items.map((asset) => (
                <tr key={asset.id} className="h-12 hover:bg-primary-soft/40">
                  <td className="px-4 font-medium">
                    <span className="flex items-center gap-2">
                      <Icon name="host" size={16} className="text-muted-foreground" />
                      {asset.name}
                    </span>
                  </td>
                  <td className="px-4">
                    <IdChip>{asset.baseUrl}</IdChip>
                  </td>
                  <td className="px-4">
                    <span className="flex flex-col gap-1">
                      <StatusChip value={asset.ownership.status} />
                      <span className="text-[11.5px] text-muted-foreground">
                        {asset.ownership.basis}
                      </span>
                    </span>
                  </td>
                  <td className="px-4">
                    <span className="inline-flex h-6 items-center rounded-md border border-border-strong px-2.5 text-xs font-medium text-muted-foreground">
                      Lab
                    </span>
                  </td>
                  <td className="px-4 text-right">
                    <LinkButton
                      href={`/demo/requests/new?assetId=${encodeURIComponent(asset.id)}`}
                      variant="secondary"
                      icon="assessments"
                    >
                      Request assessment
                    </LinkButton>
                  </td>
                </tr>
              ))}
            </DataTable>
          </div>
        </div>
        <ContextPanel
          sections={[
            {
              title: 'Ownership',
              body: 'Verified by lab trust in the demo. A production asset needs DNS TXT or HTTP proof before any test is allowed.',
            },
            {
              title: 'Scope',
              body: 'Requests are checked against the asset host and the path prefix of the test case.',
            },
          ]}
        />
      </div>
    </div>
  );
}
