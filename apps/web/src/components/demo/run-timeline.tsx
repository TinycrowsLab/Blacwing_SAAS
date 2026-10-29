'use client';

// DEMO-STORY: the live timeline. Polls the demo route for events after the last seen sequence number and stops once
// the run is terminal. Shows the state in words, not colour alone.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { StatusPill } from './status-pill';

import type { DemoRun, DemoRunEvent } from '../../app/demo/_lib/schemas';

const POLL_MS = 1500;
const TERMINAL = new Set(['completed', 'failed']);

export function RunTimeline({ runId, initial }: { readonly runId: string; readonly initial: DemoRun }) {
  const [run, setRun] = useState<DemoRun>(initial);
  const [events, setEvents] = useState<DemoRunEvent[]>(initial.events);
  const [stale, setStale] = useState(false);
  const lastSeq = useRef(initial.lastSeq);

  useEffect(() => {
    if (TERMINAL.has(run.state)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/demo/api/runs/${encodeURIComponent(runId)}?afterSeq=${lastSeq.current}`, {
            cache: 'no-store',
          });
          if (!res.ok) throw new Error(String(res.status));
          const next = (await res.json()) as DemoRun;
          lastSeq.current = next.lastSeq;
          setStale(false);
          setRun((prev) => ({ ...prev, ...next, events: prev.events }));
          if (next.events.length > 0) setEvents((prev) => [...prev, ...next.events]);
        } catch {
          setStale(true);
        }
      })();
    }, POLL_MS);
    return () => { window.clearInterval(timer); };
  }, [runId, run.state]);

  return (
    <section aria-live="polite" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>State</span>
        <StatusPill value={run.state} />
        <span>
          Requests used {run.requestsUsed} of {run.budgetRequests}
        </span>
        {stale ? <span className="text-amber-700 dark:text-amber-300">Connection lost, retrying</span> : null}
      </div>
      <ol className="space-y-2 border-l-2 border-neutral-300 pl-4 dark:border-neutral-700">
        {events.map((e) => (
          <li key={e.seq} className="text-sm">
            <span className="font-mono text-xs text-neutral-500">#{e.seq}</span> <span className="font-medium">{e.stage}</span>
            <span className="text-neutral-400"> · {e.kind}</span>
            <p>{e.message}</p>
          </li>
        ))}
      </ol>
      {run.findingId === null ? null : (
        <p className="text-sm">
          <Link className="rounded bg-neutral-900 px-3 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900" href={`/demo/findings/${run.findingId}`}>
            Open the confirmed finding
          </Link>
        </p>
      )}
    </section>
  );
}
