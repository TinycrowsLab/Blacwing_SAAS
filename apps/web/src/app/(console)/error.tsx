'use client';

// A page that could not load (the API was busy, refused or did not answer) shows this inside the shell. It tries again
// by itself, three times after 1, 2 and 4 s, re-reading the page from the server each time; then one Try again button.
// Production hides the error's message, so nothing here depends on it. A page left open across a deploy (a stale code
// chunk) reloads onto the new build instead.
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, startTransition, useEffect, useState } from 'react';

import { buttonClass, Icon } from '../../components/console/design';
import { reloadIfStaleChunk } from '../../lib/stale-chunk';

const AUTO_RETRIES = 3;
const FIRST_WAIT_MS = 1000;
/** A failure this long after the last one starts a new series of retries. */
const SERIES_MS = 30_000;

// The boundary mounts a fresh copy for each failure, so the series lives outside the component.
let series = { path: '', failures: 0, at: 0 };

export default function ConsoleError({ error, reset }: { readonly error: Error; readonly reset: () => void }): ReactNode {
  const router = useRouter();
  const path = usePathname();
  const [failures] = useState(() => {
    const now = Date.now();
    const same = series.path === path && now - series.at < SERIES_MS;
    series = { path, failures: same ? series.failures + 1 : 1, at: now };
    return series.failures;
  });
  const retrying = failures <= AUTO_RETRIES;
  const retry = (): void => {
    // router.refresh() asks the server again; reset() alone would re-render the same failed answer.
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  useEffect(() => {
    reloadIfStaleChunk(error);
  }, [error]);
  useEffect(() => {
    if (!retrying) return;
    const timer = window.setTimeout(retry, FIRST_WAIT_MS * 2 ** (failures - 1));
    return () => {
      window.clearTimeout(timer);
    };
    // Once per mounted failure.
  }, []);

  return (
    <div role="alert" className="flex max-w-xl flex-col items-start gap-4 rounded-[14px] border border-border bg-card p-6">
      <span className="flex size-10 items-center justify-center rounded-full bg-bad-soft text-bad">
        <Icon name="warn" size={20} />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[18px] font-semibold leading-7">We couldn&apos;t load this page</h1>
        <p className="m-0 text-[13.5px] leading-6 text-muted-foreground">
          Blackwing is busy or didn&apos;t answer. Nothing you entered was lost.{' '}
          {retrying ? 'Retrying…' : 'Try again in a moment.'}
        </p>
      </div>
      {retrying ? null : (
        <button
          type="button"
          onClick={() => {
            series = { path, failures: 0, at: Date.now() };
            retry();
          }}
          className={buttonClass('primary')}
        >
          Try again
        </button>
      )}
    </div>
  );
}
