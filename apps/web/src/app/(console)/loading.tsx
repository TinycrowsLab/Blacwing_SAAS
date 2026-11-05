// Shown at once on navigation while the next page loads, so a click never looks like nothing happened.
import type { ReactNode } from 'react';

export default function Loading(): ReactNode {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-3">
      <div className="h-5 w-40 rounded-md bg-surface-2 motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]" />
      <div className="h-8 w-72 rounded-md bg-surface-2 motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]" />
      <div className="h-40 rounded-xl border border-border bg-surface" />
    </div>
  );
}
