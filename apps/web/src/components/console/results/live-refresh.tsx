'use client';

// While an audit is still testing, its results page re-reads the run every few seconds (only while the tab is visible),
// so a newly proven issue, a decision or the end of the run shows without a reload.
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { useSettledAction } from './triage';

const POLL_MS = 5000;

export function LiveRefresh() {
  const router = useRouter();
  // Settles only once React has committed the refreshed page, so a refresh never overlaps the next one.
  const { run } = useSettledAction();
  const busy = useRef(false);
  useEffect(() => {
    const tick = (): void => {
      // Not while someone types (a reason): the refresh waits for the next tick instead of racing the keyboard.
      const typing =
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLInputElement;
      if (document.visibilityState !== 'visible' || typing || busy.current) return;
      busy.current = true;
      void run(() => {
        router.refresh();
        return Promise.resolve();
      }).then(() => {
        busy.current = false;
      });
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router, run]);
  return null;
}
