'use client';

import { useEffect, useState } from 'react';

/**
 * Wall clock in ms, refreshed every `intervalMs` while `active` and the tab is visible (a hidden tab catches up at
 * once when it is shown again). Is 0 until mounted so SSR and the first client render match.
 */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const tick = (): void => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, intervalMs]);
  return now;
}
