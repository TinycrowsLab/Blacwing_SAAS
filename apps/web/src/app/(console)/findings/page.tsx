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
/** Only what names an audit in the filter: its target and start time. */
const runsSchema = z.object({
  runs: z
    .array(
      z.object({
        id: z.string(),
        assetName: z.string().optional(),
        startedAt: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export default async function FindingsPage(): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  // The run list only names the audits; without it the Audit filter dates each audit by its first finding.
  const [list, runs] = await Promise.all([
    readApi('/findings').then((b) => listSchema.parse(b)),
    readApi('/dashboard')
      .then((b) =>
        runsSchema
          .parse(b)
          .runs.map((r) => ({ id: r.id, target: r.assetName ?? null, startedAt: r.startedAt })),
      )
      .catch(() => []),
  ]);
  const items = list.items.sort(bySeverity);

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">
          Findings
        </h1>
        <p className="m-0 max-w-[68ch] text-[14px] leading-[22px] text-muted-foreground">
          {items.length === 0
            ? 'The issues Blackwing finds on your sites appear here.'
            : 'Every issue Blackwing’s team raised. Proven ones were replayed with a control; kept-back ones were not proven and stay off reports unless you release them.'}
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="findings"
          title="No findings yet."
          body="Start an audit of a site you own. Each issue Blackwing proves shows up here, ready for you to release."
          action={
            <LinkButton href="/audits/new" variant="primary" icon="plus">
              New audit
            </LinkButton>
          }
        />
      ) : (
        <FindingsTable items={items} runs={runs} />
      )}
    </div>
  );
}
