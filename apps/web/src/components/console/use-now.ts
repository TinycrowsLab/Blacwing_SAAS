/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

import { useEffect, useState } from 'react';

/** Wall clock in ms, refreshed every second while `active`. Is 0 until mounted so SSR and the first client render match. */
export function useNow(active = true): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}
