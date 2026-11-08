'use client';

// A Link that keeps nudging React until the URL changes. shortcut: works around the same Next 15.5 / React 19 issue
// as `useNudge` (triage.tsx): a navigation whose data has arrived is sometimes left uncommitted until an unrelated
// update (measured 2 to 5 s in Edge, page data in at ~100 ms). Remove together with `useNudge` once fixed upstream.
import Link from 'next/link';

import { useNudge } from './nudge';

import type { ComponentProps } from 'react';

/** No prefetch unless asked: a list of these links would otherwise render every target page at once (the 429s). */
export function NavLink({ onClick, prefetch = false, ...props }: ComponentProps<typeof Link>) {
  const nudge = useNudge();
  return (
    <Link
      {...props}
      prefetch={prefetch}
      onClick={(e) => {
        onClick?.(e);
        // A new tab, a download or a cancelled click is not a navigation of this page.
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return;
        const from = window.location.pathname + window.location.search;
        nudge(() => window.location.pathname + window.location.search !== from);
      }}
    />
  );
}
