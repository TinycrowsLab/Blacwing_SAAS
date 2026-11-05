/* Presentational values (lane geometry, window sizes) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Flight deck pieces (design 1a): gauges, agent lanes on a 2 minute time axis, activity table, and the right-hand
// progress and candidate panels. All data arrives through props; the polling lives in run-view.tsx.
import Link from 'next/link';
import { useState } from 'react';

import { Card, CardHeader, Chip, SeverityChip, StatusChip, type Tone } from './design';
import {
  type Activity,
  type AgentLane,
  type Candidate,
  type MarkShape,
  LANE_WINDOW_S,
  clock,
} from './run-model';

export function Gauge({
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
  const clamped = Math.min(100, Math.max(0, pct));
  const tone = clamped >= 100 ? 'bg-bad' : clamped >= 80 ? 'bg-warn' : 'bg-primary';
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
          style={{ width: `${clamped}%` }}
        />
      </div>
    </Card>
  );
}

const LANE_H = 56;

function MarkShapeSvg({ shape }: { readonly shape: MarkShape }) {
  switch (shape) {
    case 'circle':
      return <circle r="3" style={{ fill: 'var(--primary)' }} />;
    case 'square':
      return <rect x="-3.5" y="-3.5" width="7" height="7" rx="1" style={{ fill: 'var(--text)' }} />;
    case 'ring':
      return <circle r="4" style={{ fill: 'none', stroke: 'var(--warn)', strokeWidth: 1.5 }} />;
    case 'diamond':
      return (
        <rect
          x="-4"
          y="-4"
          width="8"
          height="8"
          rx="1"
          transform="rotate(45)"
          style={{ fill: 'var(--high)' }}
        />
      );
  }
}

function Legend({ shape, label }: { readonly shape: MarkShape; readonly label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true">
        <MarkShapeSvg shape={shape} />
      </svg>
      {label}
    </span>
  );
}

/** Deterministic vertical spread so marks in the same second do not sit on top of each other. */
const markY = (seq: number): number => 10 + ((seq * 17) % 36);

export function AgentTeam({
  lanes,
  nowMs,
  running,
  pausedFrom,
}: {
  readonly lanes: readonly AgentLane[];
  readonly nowMs: number;
  readonly running: boolean;
  /** Per agent: epoch ms since when the lane is paused (Gate 2 wait or run paused). */
  readonly pausedFrom: (agent: string) => number | null;
}) {
  const from = nowMs - LANE_WINDOW_S * 1000;
  const pct = (t: number): number => ((t - from) / (LANE_WINDOW_S * 1000)) * 100;
  return (
    <Card aria-label="Agent team" as="div">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Agent team</h2>
        <span className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <Legend shape="circle" label="HTTP request" />
          <Legend shape="square" label="Tool call" />
          <Legend shape="ring" label="Blocked by policy" />
          <Legend shape="diamond" label="Candidate finding" />
          <span>Last 2 minutes</span>
        </span>
      </div>
      {lanes.map((lane) => {
        const since = pausedFrom(lane.name);
        const paused = since !== null;
        return (
          <div
            key={lane.name}
            className="grid grid-cols-[160px_minmax(0,1fr)] border-b border-border sm:grid-cols-[230px_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 flex-col gap-0.5 border-r border-border px-4 py-2.5">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${paused ? 'bg-warn' : running ? 'bg-primary motion-safe:animate-pulse' : 'bg-muted-foreground'}`}
                />
                <span className="truncate font-mono text-[13px] font-medium">{lane.name}</span>
                <span className="ml-auto hidden whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground sm:inline">
                  {lane.turns} turns, ${lane.costUsd.toFixed(2)}
                </span>
              </span>
              <span
                className={`truncate text-[12.5px] ${paused ? 'text-warn' : 'text-muted-foreground'}`}
              >
                {paused ? 'Paused. ' : ''}
                {lane.task === '' ? 'Waiting' : lane.task}
              </span>
            </div>
            <svg
              width="100%"
              height={LANE_H}
              role="img"
              aria-label={`${lane.name} activity, last 2 minutes`}
              className="block bg-surface"
            >
              <defs>
                <pattern
                  id={`hatch-${lane.name}`}
                  width="8"
                  height="8"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="4" height="8" style={{ fill: 'var(--warn-soft)' }} />
                </pattern>
              </defs>
              {paused ? (
                <rect
                  x={`${Math.max(0, pct(since))}%`}
                  y="4"
                  width={`${Math.max(0, 100 - Math.max(0, pct(since)))}%`}
                  height={LANE_H - 8}
                  rx="4"
                  style={{ fill: `url(#hatch-${lane.name})`, stroke: 'var(--warn)' }}
                />
              ) : null}
              {lane.marks
                .filter((m) => m.at >= from)
                .map((m) => (
                  <svg key={m.seq} x={`${pct(m.at)}%`} y={markY(m.seq)} overflow="visible">
                    <title>{m.title}</title>
                    <MarkShapeSvg shape={m.shape} />
                  </svg>
                ))}
            </svg>
          </div>
        );
      })}
      <div className="grid grid-cols-[160px_minmax(0,1fr)] py-1.5 text-[11px] text-muted-foreground sm:grid-cols-[230px_minmax(0,1fr)]">
        <span />
        <span className="flex justify-between pr-2">
          <span>2 min ago</span>
          <span>90 s</span>
          <span>60 s</span>
          <span>30 s</span>
          <span className="font-medium text-primary">Now</span>
        </span>
      </div>
    </Card>
  );
}

const FILTERS = ['All agents', 'HTTP', 'Policy', 'Errors only'] as const;
type Filter = (typeof FILTERS)[number];

const KIND_TONE: Record<Activity['kind'], Tone> = {
  HTTP: 'muted',
  Tool: 'primary',
  Policy: 'warn',
  'Gate 2': 'warn',
  Finding: 'high',
  Validator: 'primary',
  Agent: 'muted',
  Run: 'muted',
};

function passes(filter: Filter, row: Activity): boolean {
  if (filter === 'HTTP') return row.kind === 'HTTP';
  if (filter === 'Policy') return row.kind === 'Policy' || row.kind === 'Gate 2';
  if (filter === 'Errors only') return row.isError;
  return true;
}

export function ActivityTable({ rows }: { readonly rows: readonly Activity[] }) {
  const [filter, setFilter] = useState<Filter>('All agents');
  const shown = rows
    .filter((r) => passes(filter, r))
    .slice(-100)
    .reverse();
  return (
    <Card aria-labelledby="activity-h" as="section">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 id="activity-h" className="text-sm font-semibold">
          Activity
        </h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
              }}
              className={`h-8 rounded-full px-3 text-xs font-medium ${filter === f ? 'bg-text text-bg' : 'bg-surface-2 text-foreground hover:brightness-95'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted-foreground">Nothing to show yet.</p>
      ) : (
        <ol className="max-h-[480px] divide-y divide-border overflow-auto">
          {shown.map((r) => (
            <li
              key={r.seq}
              className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] md:grid-cols-[64px_170px_70px_minmax(0,1fr)_auto]"
            >
              <time
                dateTime={r.at}
                className="pt-0.5 font-mono text-[11.5px] text-muted-foreground"
              >
                {clock(r.at)}
              </time>
              <span className="truncate pt-0.5 font-mono text-xs font-medium">{r.agent}</span>
              <span className="col-start-2 md:col-start-auto">
                <Chip tone={KIND_TONE[r.kind]}>{r.kind}</Chip>
              </span>
              <span className="col-start-2 min-w-0 break-words leading-5 md:col-start-auto">
                {r.text}
              </span>
              <span className="col-start-2 font-mono text-[11.5px] text-muted-foreground md:col-start-auto">
                {r.meta}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function ProgressCard({
  stats,
}: {
  readonly stats: {
    readonly httpSent: number;
    readonly blocked: number;
    readonly candidates: number;
    readonly confirmed: number;
  };
}) {
  const parts = [
    { label: 'HTTP sent', n: stats.httpSent, bar: 'bg-primary' },
    { label: 'Blocked', n: stats.blocked, bar: 'bg-warn' },
    { label: 'Candidates', n: stats.candidates, bar: 'bg-med' },
    { label: 'Confirmed', n: stats.confirmed, bar: 'bg-ok' },
  ];
  const total = Math.max(
    1,
    parts.reduce((sum, p) => sum + p.n, 0),
  );
  return (
    <Card aria-labelledby="progress-h" as="section">
      <CardHeader id="progress-h" title="Progress" />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          {parts.map((p) => (
            <div key={p.label} className={p.bar} style={{ width: `${(p.n / total) * 100}%` }} />
          ))}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
          {parts.map((p) => (
            <div key={p.label} className="flex items-center gap-2">
              <span className={`size-2 rounded-[2px] ${p.bar}`} aria-hidden="true" />
              <dt className="text-muted-foreground">{p.label}</dt>
              <dd className="ml-auto font-semibold tabular-nums">{p.n}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

export function CandidateList({
  items,
  running,
}: {
  readonly items: readonly Candidate[];
  readonly running: boolean;
}) {
  return (
    <Card aria-labelledby="cand-h" as="section">
      <CardHeader id="cand-h" title="Candidate findings" meta="Confirmed only by the validator" />
      {items.length === 0 ? (
        <p className="px-4 py-5 text-[13px] text-muted-foreground">
          {running
            ? 'None yet. The validator replays every candidate before it is confirmed.'
            : 'No candidate was submitted in this run.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((c) => (
            <li key={c.candidateId} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex items-center gap-2">
                <SeverityChip severity={c.severity} />
                <span className="ml-auto">
                  {c.status === 'validating' ? (
                    <span className="text-xs font-medium text-primary">
                      Validating, replay {c.replays} of 3
                    </span>
                  ) : (
                    <StatusChip value={c.status} />
                  )}
                </span>
              </div>
              {c.findingId === null ? (
                <span className="text-[13px] font-medium leading-5">{c.title}</span>
              ) : (
                <Link
                  href={`/demo/findings/${c.findingId}`}
                  className="text-[13px] font-medium leading-5 text-primary hover:underline"
                >
                  {c.title}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
