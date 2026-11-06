// Findings (experience spec §2, §8): every finding in the workspace, newest first, filtered by status (including Kept
// back), severity and target. Filtering is instant on the client; the URL keeps the filters for a reload.
import { z } from 'zod';

import { EmptyState, LinkButton, queryText } from '../../../components/console/design';
import { FindingsTable } from '../../../components/console/results/findings-table';
import { FINDING_STATUSES, SEVERITIES } from '../../../components/console/results/model';
import { callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { findingSummarySchema } from '../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Findings' };

const listSchema = z.object({ items: z.array(findingSummarySchema) });

export default async function FindingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const query = await searchParams;
  const { items } = listSchema.parse(await callApi(session, '/findings'));
  // The initial filters come from the URL (a reload or shared link); later clicks filter on the client.
  const target = queryText(query.target);
  const initial = {
    status: FINDING_STATUSES.find((s) => s.key === queryText(query.status))?.key,
    severity: SEVERITIES.find((s) => s === queryText(query.severity)),
    target: items.some((f) => f.assetName === target) ? target : undefined,
  };

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">Findings</h1>
        <p className="m-0 max-w-[68ch] text-[14px] leading-[22px] text-muted-foreground">
          Every issue Claude&rsquo;s team raised. Proven ones were replayed by the validator with a control; kept-back ones
          were not proven and stay off reports unless you release them with a reason.
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="findings"
          title="No findings yet."
          body="They appear here once Claude proves an issue. Start an audit of a site you own to begin."
          action={
            <LinkButton href="/audits/new" variant="primary" icon="plus">
              New audit
            </LinkButton>
          }
        />
      ) : (
        <FindingsTable items={items} initial={initial} viewerName={session.user.name} />
      )}
    </div>
  );
}
