'use client';

// The report's format selector and download (experience spec §7, §8). The file is fetched first, so a failure says so
// on the page ("Your findings are safe") instead of a broken download, and a success says "Report downloaded". Under
// 768 px the download button sticks to the bottom of the screen and says there what happened. A finding offers the two
// formats its route renders.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { InlineMessage } from '../design';
import { PendingButton } from '../design-client';
import { runAgainAction } from './actions';
import { useNudge } from './triage';

const FORMATS = [
  { key: 'html', label: 'HTML' },
  { key: 'md', label: 'Markdown' },
  { key: 'json', label: 'JSON' },
  { key: 'sarif', label: 'SARIF' },
] as const;
type Format = (typeof FORMATS)[number]['key'];
export const FINDING_FORMATS: readonly Format[] = ['html', 'md'];

const FILENAME = /filename="([^"]+)"/;
const TOAST_MS = 2400;
const REVOKE_MS = 1000;

export function ReportDownload({
  href,
  primary,
  formats = FORMATS.map((f) => f.key),
  sticky = true,
  note = 'released issues only',
}: {
  readonly href: string;
  readonly primary: boolean;
  readonly formats?: readonly Format[];
  /** Under 768 px, pin the button to the bottom of the screen (one per page). */
  readonly sticky?: boolean;
  readonly note?: string;
}) {
  const offered = FORMATS.filter((f) => formats.includes(f.key));
  const [format, setFormat] = useState<Format>('html');
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'done') return;
    const t = window.setTimeout(() => {
      setState('idle');
    }, TOAST_MS);
    return () => {
      window.clearTimeout(t);
    };
  }, [state]);

  async function download(): Promise<void> {
    setState('idle');
    try {
      const response = await fetch(`${href}?format=${format}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      const name = FILENAME.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `report.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
      }, REVOKE_MS);
      setState('done');
    } catch {
      setState('failed');
    }
  }

  const label = FORMATS.find((f) => f.key === format)?.label ?? format;
  const message = (where: string) => (
    <div aria-live="polite" className={where}>
      {state === 'done' ? <InlineMessage tone="ok">Report downloaded.</InlineMessage> : null}
      {state === 'failed' ? (
        <InlineMessage tone="bad">
          The report couldn&rsquo;t be built. Your findings are safe.{' '}
          <button type="button" className="font-medium underline" onClick={() => void download()}>
            Retry
          </button>
        </InlineMessage>
      ) : null}
    </div>
  );
  const button = (extra: string) => (
    <PendingButton
      variant={primary ? 'primary' : 'secondary'}
      icon="download"
      pendingLabel="Building the report…"
      stayPending
      onAction={async () => {
        await download();
        return false;
      }}
      className={extra}
    >
      Download report
    </PendingButton>
  );
  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="radiogroup"
        aria-label="Report format"
        className="grid gap-1 rounded-[10px] bg-surface-2 p-1"
        style={{ gridTemplateColumns: `repeat(${offered.length}, minmax(0, 1fr))` }}
      >
        {offered.map((f) => (
          <button
            key={f.key}
            type="button"
            role="radio"
            aria-checked={format === f.key}
            onClick={() => {
              setFormat(f.key);
            }}
            className={`h-8 rounded-[7px] text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${format === f.key ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(31,23,4,.08)]' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {sticky ? (
        <>
          <div className="hidden md:flex md:flex-col">{button('h-11 w-full')}</div>
          <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-1.5 border-t border-border bg-bg/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur md:hidden">
            {message('flex flex-col')}
            <div className="flex flex-col">{button('h-12 w-full')}</div>
            <span className="block text-center text-[11.5px] text-muted-foreground">
              {label} · {note}
            </span>
          </div>
          {message('hidden md:block')}
        </>
      ) : (
        <>
          <div className="flex flex-col">{button('h-11 w-full')}</div>
          {message('')}
        </>
      )}
    </div>
  );
}

/** "Run this audit again": a new pending audit with the same answers, opened at its plan. */
export function RunAgain({ requestId }: { readonly requestId: string }) {
  const router = useRouter();
  const nudge = useNudge();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <PendingButton
        variant="secondary"
        icon="repeat"
        pendingLabel="Preparing the plan…"
        stayPending
        className="h-10 self-start"
        onAction={async () => {
          setError(null);
          const result = await runAgainAction(requestId);
          if (!result.ok) {
            setError(`We couldn't copy this audit: ${result.message}`);
            return false;
          }
          window.dispatchEvent(new Event('bw:refresh'));
          const from = window.location.pathname;
          router.push(`/audits/${result.data.id}`);
          nudge(() => window.location.pathname !== from);
          return true;
        }}
      >
        Run this audit again
      </PendingButton>
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
    </div>
  );
}
