// Findings (experience spec §2, §8): every finding in the workspace, most severe first (as on Results), filtered by
// status (including Kept back), severity, target and audit. Filtering is instant on the client and the URL keeps the filters.
import { z } from 'zod';

import { EmptyState, LinkButton } from '../../../components/console/design';
import { FindingsTable } from '../../../components/console/results/findings-table';
import { readApi } from '../../../components/console/results/load';
import { bySeverity } from '../../../components/console/results/model';
import { getViewer } from '../../../lib/auth';
import { findingSummarySchema } from '../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Findings' };

const listSchema = z.object({ items: z.array(findingSummarySchema) });

export default async function FindingsPage(): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const items = listSchema.parse(await readApi('/findings')).items.sort(bySeverity);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">Findings</h1>
        <p className="m-0 max-w-[68ch] text-[14px] leading-[22px] text-muted-foreground">
          {items.length === 0
            ? 'The issues Claude finds on your sites appear here.'
            : 'Every issue Claude’s team raised. Proven ones were replayed with a control; kept-back ones were not proven and stay off reports unless you release them.'}
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="findings"
          title="No findings yet."
          body="Start an audit of a site you own. Each issue Claude proves shows up here, ready for you to release."
          action={
            <LinkButton href="/audits/new" variant="primary" icon="plus">
              New audit
            </LinkButton>
          }
        />
      ) : (
        <FindingsTable items={items} />
      )}
    </div>
  );
}
