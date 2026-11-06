'use client';

// A page that could not load (the API refused or did not answer) shows this inside the shell, with one way forward.
// A page left open across a deploy (a stale code chunk) reloads onto the new build instead.
import { type ReactNode, useEffect } from 'react';

import { buttonClass, Icon } from '../../components/console/design';
import { reloadIfStaleChunk } from '../../lib/stale-chunk';


export default function ConsoleError({ error, reset }: { readonly error: Error; readonly reset: () => void }): ReactNode {
  useEffect(() => {
    reloadIfStaleChunk(error);
  }, [error]);
  return (
    <div role="alert" className="flex max-w-xl flex-col items-start gap-4 rounded-[14px] border border-border bg-card p-6">
      <span className="flex size-10 items-center justify-center rounded-full bg-bad-soft text-bad">
        <Icon name="warn" size={20} />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[18px] font-semibold leading-7">We couldn&apos;t load this page</h1>
        <p className="m-0 text-[13.5px] leading-6 text-muted-foreground">
          Blackwing didn&apos;t answer in time. Nothing you entered was lost. Try again in a moment.
        </p>
      </div>
      <button type="button" onClick={reset} className={buttonClass('primary')}>
        Try again
      </button>
    </div>
  );
}
