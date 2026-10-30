/* Presentational values (pixel sizes, opacity steps, poll and tick intervals) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design-system pixel and timing values, see design/README.md */
'use client';

// DEMO-STORY flight deck (design 1a, "Live run"): agents as lanes on a time axis, the authorisation strip, budget
// gauges and the activity feed. Polls the demo route for new events and stops once the run is terminal. State is in
// words, never colour alone. Agent and runner text is labelled "not verified" where the design requires it.
import { useEffect, useMemo, useRef, useState } from 'react';

import { Card, CardHeader, Chip, Icon, SeverityChip, StatusChip, type Tone } from './design';

import type { DemoRun, DemoRunEvent } from '../../app/demo/_lib/schemas';

const POLL_MS = 1500;
const TERMINAL = new Set(['completed', 'failed']);

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19) + ' UTC';
}

/** Dot shape per event kind, as in the design legend: circle HTTP, square tool, ring block, diamond finding. */
function markFor(kind: string): { shape: 'circle' | 'square' | 'ring' | 'diamond'; tone: Tone } {
  if (/block|refus|denied|deny/.test(kind)) return { shape: 'ring', tone: 'warn' };
  if (/finding|confirm|candidate/.test(kind)) return { shape: 'diamond', tone: 'high' };
  if (/probe|http|request/.test(kind)) return { shape: 'circle', tone: 'primary' };
  return { shape: 'square', tone: 'neutral' };
}

const MARK_CLASS: Record<Tone, string> = {
  primary: 'bg-primary',
  neutral: 'bg-text',
  warn: 'border-[1.5px] border-warn bg-transparent',
  high: 'bg-high',
  ok: 'bg-ok',
  bad: 'bg-bad',
  muted: 'bg-muted-foreground',
  kill: 'bg-kill',
  crit: 'bg-crit',
  med: 'bg-med',
  low: 'bg-low',
  info: 'bg-sinfo',
  navy: 'bg-navy-bar',
};

function Mark({
  kind,
  left,
  lane,
}: {
  readonly kind: string;
  readonly left: number;
  readonly lane: number;
}) {
  const m = markFor(kind);
  const top = 8 + ((lane * 13) % 30);
  return (
    <span
      title={kind}
      className={`absolute size-2 ${m.shape === 'circle' ? 'rounded-full' : m.shape === 'diamond' ? 'rotate-45 rounded-[1px]' : m.shape === 'ring' ? 'rounded-full' : 'rounded-[1px]'} ${MARK_CLASS[m.tone]}`}
      style={{ left: `${left}%`, top }}
    />
  );
}

export function RunTimeline({
  runId,
  initial,
  requestTitle,
  authItems,
  findingTitle,
  findingSeverity,
}: {
  readonly runId: string;
  readonly initial: DemoRun;
  readonly requestTitle: string;
  readonly authItems: readonly { k: string; v: string }[];
  readonly findingTitle: string | null;
  readonly findingSeverity: string | null;
}) {
  const [run, setRun] = useState<DemoRun>(initial);
  const [events, setEvents] = useState<DemoRunEvent[]>(initial.events);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastSeq = useRef(initial.lastSeq);

  useEffect(() => {
    if (TERMINAL.has(run.state)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/demo/api/runs/${encodeURIComponent(runId)}?afterSeq=${lastSeq.current}`,
            { cache: 'no-store' },
          );
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
    return () => {
      window.clearInterval(timer);
    };
  }, [runId, run.state]);

  useEffect(() => {
    if (TERMINAL.has(run.state)) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(t);
    };
  }, [run.state]);

  const start = useMemo(() => {
    const first = events[0]?.at ?? run.startedAt ?? run.createdAt;
    return new Date(run.startedAt ?? first).getTime();
  }, [events, run.startedAt, run.createdAt]);

  const end =
    TERMINAL.has(run.state) && run.finishedAt !== null ? new Date(run.finishedAt).getTime() : now;
  const elapsed = Math.max(0, (end - start) / 1000);
  const windowMs = Math.max(end - start, 1000);

  const lanes = useMemo(() => {
    const order: string[] = [];
    for (const e of events) if (!order.includes(e.stage)) order.push(e.stage);
    return order.map((stage) => ({ stage, events: events.filter((e) => e.stage === stage) }));
  }, [events]);

  const running = !TERMINAL.has(run.state);
  const reqPct =
    run.budgetRequests > 0 ? Math.min(100, (run.requestsUsed / run.budgetRequests) * 100) : 0;
  const feed = [...events].reverse();

  return (
    <section aria-live="polite" aria-label="Live run" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip value={run.state} />
        <span className="text-[13px] text-muted-foreground">
          {running ? 'Live. Updates every 1.5 s.' : 'Run finished. The timeline is final.'}
        </span>
        {stale ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-warn">
            <Icon name="warn" size={14} /> Connection lost, retrying
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-[220px_repeat(2,minmax(0,1fr))]">
        <Card className="flex flex-col gap-0.5 p-4" as="div">
          <span className="text-xs text-muted-foreground">Elapsed</span>
          <span className="text-[30px] font-semibold leading-9 tabular-nums">{mmss(elapsed)}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {clock(new Date(end).toISOString())}
          </span>
        </Card>
        <Gauge
          label="Requests"
          cap={`budget ${run.budgetRequests}`}
          value={`${run.requestsUsed} of ${run.budgetRequests}`}
          pct={reqPct}
        />
        <Gauge
          label="Events"
          cap="runner stages"
          value={String(events.length)}
          pct={Math.min(100, events.length * 8)}
        />
      </div>

      <div
        role="status"
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border bg-card px-4 py-3"
      >
        {authItems.map((a) => (
          <span key={a.k} className="flex flex-col">
            <span className="text-[11.5px] text-muted-foreground">{a.k}</span>
            <span className="text-[12.5px] font-medium">{a.v}</span>
          </span>
        ))}
      </div>

      <Card aria-label="Stages as lanes" as="div">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">Stages</span>
          <span className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <Legend shape="circle" tone="primary" label="HTTP request" />
            <Legend shape="square" tone="neutral" label="Tool call" />
            <Legend shape="ring" tone="warn" label="Blocked by policy" />
            <Legend shape="diamond" tone="high" label="Candidate finding" />
          </span>
        </div>
        {lanes.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-muted-foreground">
            No events yet. The runner is starting.
          </p>
        ) : (
          lanes.map((lane, li) => (
            <div
              key={lane.stage}
              className="grid grid-cols-[200px_minmax(0,1fr)] border-b border-border last:border-b-0"
            >
              <div className="flex flex-col gap-0.5 border-r border-border px-4 py-2.5">
                <span className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${running ? 'bg-primary motion-safe:animate-pulse' : 'bg-muted-foreground'}`}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-[13px] font-medium">{lane.stage}</span>
                  <span className="ml-auto text-[11.5px] tabular-nums text-muted-foreground">
                    {lane.events.length} events
                  </span>
                </span>
              </div>
              <div className="relative h-14 overflow-hidden bg-surface">
                {lane.events.map((e) => {
                  const pct = Math.min(99, ((new Date(e.at).getTime() - start) / windowMs) * 100);
                  return <Mark key={e.seq} kind={e.kind} left={pct} lane={li} />;
                })}
                <span className="absolute inset-y-0 right-0 w-px bg-primary" aria-hidden="true" />
              </div>
            </div>
          ))
        )}
        <div className="flex justify-between border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
          <span>Start</span>
          <span className="font-medium text-primary">Now</span>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card aria-labelledby="activity-h" as="section">
          <CardHeader
            id="activity-h"
            title="Activity"
            meta="Runner events. Agent text is labelled not verified."
          />
          {feed.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">
              Waiting for the first event.
            </p>
          ) : (
            <ol className="divide-y divide-border">
              {feed.map((e) => (
                <li
                  key={e.seq}
                  className="grid grid-cols-[84px_120px_minmax(0,1fr)] items-start gap-3 px-4 py-2.5"
                >
                  <time
                    dateTime={e.at}
                    className="pt-0.5 font-mono text-[11.5px] text-muted-foreground"
                  >
                    {clock(e.at).slice(0, 8)}
                  </time>
                  <span className="pt-0.5 font-mono text-xs font-medium">{e.stage}</span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Chip
                        tone={
                          markFor(e.kind).tone === 'neutral'
                            ? 'muted'
                            : markFor(e.kind).tone === 'warn'
                              ? 'warn'
                              : 'primary'
                        }
                      >
                        {e.kind}
                      </Chip>
                      <span className="font-mono text-[11px] text-muted-foreground">#{e.seq}</span>
                    </span>
                    <span className="text-[13px] leading-5">{e.message}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card aria-labelledby="req-h" as="section">
            <CardHeader id="req-h" title="Test case" meta={requestTitle} />
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-muted-foreground">Requests used</span>
                <span className="font-semibold tabular-nums">
                  {run.requestsUsed} of {run.budgetRequests}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-700 motion-reduce:transition-none"
                  style={{ width: `${reqPct}%` }}
                />
              </div>
            </div>
          </Card>
          <Card aria-labelledby="cand-h" as="section">
            <CardHeader id="cand-h" title="Candidate findings" meta="Released only after Gate 3" />
            {findingTitle === null ? (
              <p className="px-4 py-5 text-[13px] text-muted-foreground">
                {running
                  ? 'None yet. The validator replays a candidate before it is confirmed.'
                  : 'No candidate was confirmed in this run.'}
              </p>
            ) : (
              <div className="flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  {findingSeverity === null ? null : <SeverityChip severity={findingSeverity} />}
                  <span className="ml-auto">
                    <StatusChip value="confirmed" />
                  </span>
                </div>
                <span className="text-[13px] font-medium leading-5">{findingTitle}</span>
              </div>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}

function Gauge({
  label,
  cap,
  value,
  pct,
}: {
  readonly label: string;
  readonly cap: string;
  readonly value: string;
  readonly pct: number;
}) {
  const tone = pct >= 100 ? 'bg-bad' : pct >= 80 ? 'bg-warn' : 'bg-primary';
  return (
    <Card className="flex flex-col gap-2.5 p-4" as="div">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-[11.5px] text-muted-foreground">{cap}</span>
      </div>
      <span className="text-[22px] font-semibold leading-7 tabular-nums">{value}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${tone} transition-[width] duration-700 motion-reduce:transition-none`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </Card>
  );
}

function Legend({
  shape,
  tone,
  label,
}: {
  readonly shape: 'circle' | 'square' | 'ring' | 'diamond';
  readonly tone: Tone;
  readonly label: string;
}) {
  const cls =
    shape === 'ring'
      ? 'rounded-full border-[1.5px] border-warn'
      : shape === 'diamond'
        ? 'rotate-45 rounded-[1px] bg-high'
        : shape === 'circle'
          ? 'rounded-full bg-primary'
          : 'rounded-[1px] bg-text';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-[7px] ${cls}`} aria-hidden="true" data-tone={tone} />
      {label}
    </span>
  );
}
