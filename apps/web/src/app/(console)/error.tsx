'use client';

// A page that could not load (the API refused or is down) shows this inside the shell, with a retry.
import { Card } from '../../components/console/design';

import type { ReactNode } from 'react';

export default function ConsoleError({ reset }: { readonly reset: () => void }): ReactNode {
  return (
    <Card as="div" className="flex max-w-xl flex-col gap-3 p-5">
      <h1 className="text-[18px] font-semibold leading-7">This page could not load</h1>
      <p className="text-[13.5px] leading-6 text-muted-foreground">
        The Blackwing API did not answer. Check that it is running, then try again.
      </p>
      <div>
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:brightness-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          Try again
        </button>
      </div>
    </Card>
  );
}
