'use client';

// "Retest now" on a proven finding (experience spec §7): the runner replays the probe and its control against the site
// as it is today and records "Still present", "Fixed" or "Inconclusive". Only probes that read; anything that changes
// data needs a new audit (Gate 2). The page refreshes itself while a retest is queued or running.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { retestFindingAction } from '../../../app/(console)/findings/actions';
import { Chip, InlineMessage } from '../design';
import { PendingButton } from '../design-client';
import { plainReason } from './issue-body';
import { LocalTime } from './local-time';

import type { FindingDetail } from './model';

const POLL_MS = 3000;
const RESULT: Readonly<Record<string, { text: string; tone: 'bad' | 'ok' | 'neutral' }>> = {
  still_present: { text: 'Still present', tone: 'bad' },
  fixed: { text: 'Fixed', tone: 'ok' },
  inconclusive: { text: 'Inconclusive', tone: 'neutral' },
};

export function RetestCard({ finding }: { readonly finding: Pick<FindingDetail, 'id' | 'retests'> }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const latest = finding.retests[0];
  const open = latest !== undefined && (latest.status === 'queued' || latest.status === 'running');
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(t);
    };
  }, [open, router]);
  const result = latest?.result === null || latest?.result === undefined ? null : (RESULT[latest.result] ?? null);
  const why = typeof latest?.detail.reason === 'string' ? plainReason(latest.detail.reason) : null;
  return (
    <section className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-4">
      <h2 className="m-0 text-[14.5px] font-semibold text-foreground">Retest</h2>
      {latest === undefined ? (
        <p className="m-0 text-[12.5px] leading-5 text-muted-foreground">
          After a fix, Blackwing sends the probe and its control again and says whether the issue is still there.
        </p>
      ) : open ? (
        <p role="status" className="m-0 text-[12.5px] leading-5 text-muted-foreground">
          {latest.status === 'queued' ? 'Waiting for a free runner…' : 'Replaying the probe and its control…'}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            {result === null ? <Chip tone="neutral">Could not finish</Chip> : <Chip tone={result.tone}>{result.text}</Chip>}
            {latest.finishedAt === null ? null : <LocalTime iso={latest.finishedAt} style="datetime" />}
          </span>
          {why === null ? null : <span className="text-[12.5px] leading-5 text-muted-foreground">{why}</span>}
        </div>
      )}
      {open ? null : (
        <PendingButton
          variant="secondary"
          icon="repeat"
          pendingLabel="Asking the runner…"
          className="h-9 self-start"
          onAction={async () => {
            setError(null);
            const r = await retestFindingAction(finding.id);
            if (!r.ok) {
              setError(r.message);
              return false;
            }
            router.refresh();
            return true;
          }}
        >
          Retest now
        </PendingButton>
      )}
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
    </section>
  );
}
