'use client';

// The report's format selector and download (experience spec §7, §8). The file is fetched first, so a failure says so
// on the page ("Your findings are safe") instead of a broken download, and a success says "Report downloaded". Under
// 768 px the download button sticks to the bottom of the screen.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { InlineMessage } from '../design';
import { PendingButton } from '../design-client';
import { runAgainAction } from './actions';

const FORMATS = [
  { key: 'html', label: 'HTML' },
  { key: 'md', label: 'Markdown' },
  { key: 'json', label: 'JSON' },
  { key: 'sarif', label: 'SARIF' },
] as const;
type Format = (typeof FORMATS)[number]['key'];

const FILENAME = /filename="([^"]+)"/;
const TOAST_MS = 2400;
const REVOKE_MS = 1000;

export function ReportDownload({ href, primary }: { readonly href: string; readonly primary: boolean }) {
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
      <div role="radiogroup" aria-label="Report format" className="grid grid-cols-4 gap-1 rounded-[10px] bg-surface-2 p-1">
        {FORMATS.map((f) => (
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
      <div className="hidden md:flex md:flex-col">{button('h-11 w-full')}</div>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur md:hidden">
        <div className="flex flex-col">{button('h-12 w-full')}</div>
        <span className="mt-1 block text-center text-[11.5px] text-muted-foreground">{label} · released issues only</span>
      </div>
      <div aria-live="polite">
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
    </div>
  );
}

/** "Run this audit again": a new pending audit with the same answers, opened at its plan. */
export function RunAgain({ requestId }: { readonly requestId: string }) {
  const router = useRouter();
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
          router.push(`/audits/${result.data.id}`);
          return true;
        }}
      >
        Run this audit again
      </PendingButton>
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
    </div>
  );
}
