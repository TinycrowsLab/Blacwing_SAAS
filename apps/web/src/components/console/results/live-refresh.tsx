'use client';

// While an audit is still testing, its results page re-reads the run every few seconds (only while the tab is visible),
// so a newly proven issue, a decision or the end of the run shows without a reload.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const POLL_MS = 5000;

export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const tick = (): void => {
      // Not while someone types (a reason): the refresh waits for the next tick instead of racing the keyboard.
      const typing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      if (document.visibilityState === 'visible' && !typing) router.refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router]);
  return null;
}
