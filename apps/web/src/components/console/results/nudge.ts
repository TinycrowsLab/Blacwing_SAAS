'use client';

// Kept apart from triage.tsx (which imports server actions) so plain links and pure modules can use it.
import { useCallback, useState } from 'react';

const NUDGE_MS = 150;
const NUDGE_MAX = 40;

/**
 * shortcut: in Edge (Next 15.5, React 19.3) a refreshed page's transition is sometimes left suspended without a ping,
 * so the new page only appears with the next unrelated update (the sidebar's 5 s poll): measured 2 to 5 s instead of
 * ~0.2 s. Any update makes React retry it, so this sends small no-op updates until `done()` says the page is in (at
 * most 6 s). Remove once the upstream bug is fixed (re-measure `router.refresh()` on /ledger).
 */
export function useNudge(): (done: () => boolean) => void {
  const [, setTick] = useState(0);
  return useCallback((done: () => boolean) => {
    let n = 0;
    const tick = (): void => {
      if (done() || n > NUDGE_MAX) return;
      n += 1;
      setTick((x) => x + 1);
      window.setTimeout(tick, NUDGE_MS);
    };
    window.setTimeout(tick, NUDGE_MS);
  }, []);
}
