'use client';

// The last-resort boundary (an error in the root or console layout, e.g. the sidebar's Stop dialog). A page left open
// across a deploy reloads onto the new build instead of a blank "Application error"; anything else gets a calm page
// with one way forward.
import './globals.css';

import { type ReactNode, useEffect } from 'react';

import { reloadIfStaleChunk } from '../lib/stale-chunk';


export default function GlobalError({ error, reset }: { readonly error: Error; readonly reset: () => void }): ReactNode {
  useEffect(() => {
    reloadIfStaleChunk(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="bg-bg text-foreground">
        <main role="alert" className="mx-auto flex max-w-md flex-col items-start gap-4 px-4 py-24">
          <h1 className="m-0 text-[20px] font-semibold leading-7">Blackwing needs a moment</h1>
          <p className="m-0 text-[14px] leading-6 text-muted-foreground">
            This page hit a problem. Any audit that was running keeps running, and anything you sent was recorded.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.reload();
            }}
            className="inline-flex h-10 items-center rounded-[10px] bg-text px-4 text-[14px] font-medium text-bg"
          >
            Reload the page
          </button>
          <button type="button" onClick={reset} className="text-[13px] font-medium text-gold-ink underline">
            Try without reloading
          </button>
        </main>
      </body>
    </html>
  );
}
