/* Presentational values (lane geometry, window sizes) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// The run's expert views and its right-hand panel (experience spec §5.2 items 4 and 6). The Flight deck tab keeps the
// agent lanes on a 2 minute axis and the raw activity; the Test plan and Requests tabs list what the runner recorded.
// The panel shows the limits you approved, the test plan and what was found so far. All data arrives through props.
import Link from 'next/link';
import { useState } from 'react';

import { Card, Icon, KindTag, SeverityChip, VerdictMark, gaugeTone, withRedactions } from './design';
import { Markdown, stripMarkdown } from './markdown';
import {
  type Activity,
  type AgentLane,
  type Candidate,
  type Exchange,
  type MarkShape,
  type TestCase,
  LANE_WINDOW_S,
  VALIDATOR_REPLAYS,
  pathOf,
} from './run-model';
import { agentName } from '../../lib/agents';

/** Seconds-precise local time; these tabs render only in the browser, after a click. */
const localClock = (iso: string): string => new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(iso));

/** Activity rows the runner writes as itself or for a person. */
const WHO: Readonly<Record<string, string>> = { run: 'Blackwing', gate2: 'Your decision', gate3: 'Your release' };

const GAUGE_TONE = {
  primary: { text: 'text-foreground', bar: 'bg-gold' },
  warn: { text: 'text-warn', bar: 'bg-warn' },
  bad: { text: 'text-bad', bar: 'bg-bad' },
} as const;

/** One limit as "{x} of {cap}": gold, amber from 80 %, red at 100 % (the runner stops at the first limit reached). */
function Limit({ label, value, cap, pct }: { readonly label: string; readonly value: string; readonly cap: string; readonly pct: number }) {
  const tone = GAUGE_TONE[gaugeTone(pct)];
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-baseline text-[12px] text-muted-foreground">
        {label}
        <b className={`ml-auto mr-1 font-semibold tabular-nums ${tone.text}`}>{value}</b>
        of {cap}
      </div>
      <div className="h-[5px] overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${tone.bar} transition-[width] duration-700 motion-reduce:transition-none`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
    </div>
  );
}

const minutes = (s: number): string => (s < 60 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}m`);
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function LimitsPanel({
  elapsedS,
  budget,
  requestsUsed,
  costUsd,
}: {
  readonly elapsedS: number;
  readonly budget: { readonly seconds: number; readonly requests: number; readonly costUsd: number };
  readonly requestsUsed: number;
  readonly costUsd: number;
}) {
  return (
    <section aria-labelledby="limits-h">
      <h2 id="limits-h" className="mb-2 flex items-baseline text-[12.5px] font-semibold">
        Limits you approved
        <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">stops at the first</span>
      </h2>
      <Limit label="Time" value={minutes(elapsedS)} cap={minutes(budget.seconds)} pct={(elapsedS / Math.max(1, budget.seconds)) * 100} />
      <Limit
        label="Requests"
        value={requestsUsed.toLocaleString('en-US')}
        cap={budget.requests.toLocaleString('en-US')}
        pct={(requestsUsed / Math.max(1, budget.requests)) * 100}
      />
      <Limit label="Model spend" value={money(costUsd)} cap={money(budget.costUsd)} pct={(costUsd / Math.max(0.01, budget.costUsd)) * 100} />
    </section>
  );
}

/**
 * "Account use": requests actually sent as each test account (from `http.sent.asRole`), so signed-in testing is seen to
 * happen, or seen not to. `warned`: the runner said no request has used them yet.
 */
export function AccountsPanel({
  roles,
  used,
  warned,
}: {
  readonly roles: readonly string[];
  readonly used: ReadonlyMap<string, number>;
  readonly warned: boolean;
}) {
  if (roles.length === 0) return null;
  const total = roles.reduce((n, r) => n + (used.get(r) ?? 0), 0);
  return (
    <section aria-labelledby="accounts-h">
      <h2 id="accounts-h" className="mb-2 flex items-baseline text-[12.5px] font-semibold">
        Account use
        <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">requests sent as</span>
      </h2>
      <dl className="m-0 flex flex-col gap-[3px] text-[12px] text-muted-foreground">
        {roles.map((r) => (
          <div key={r} className="flex items-center gap-1.5">
            <dt className="min-w-0 truncate font-mono text-foreground">{r}</dt>
            <dd className="m-0 ml-auto font-semibold tabular-nums text-foreground">{(used.get(r) ?? 0).toLocaleString('en-US')}</dd>
          </div>
        ))}
      </dl>
      {total === 0 && warned ? (
        <p className="m-0 mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-4 text-warn">
          <Icon name="warn" size={12} className="mt-0.5 shrink-0" />
          No request has used your test accounts yet.
        </p>
      ) : null}
    </section>
  );
}

const PLAN_PARTS = [
  { key: 'done', label: 'Done', colour: 'var(--text)' },
  { key: 'running', label: 'Running', colour: 'var(--slate)' },
  { key: 'waiting', label: 'Waiting on you', colour: 'var(--gold)' },
  { key: 'queued', label: 'Queued', colour: 'var(--border2)' },
  { key: 'skipped', label: 'Skipped', colour: 'var(--faint)' },
  { key: 'blocked', label: 'Blocked', colour: 'var(--warn)' },
  { key: 'unfinished', label: 'Not finished', colour: 'var(--border2)' },
] as const;
type PlanPart = (typeof PLAN_PARTS)[number]['key'];

/**
 * An open case is "held for a decision" while a Gate 2 request open for it names it (`case:<id>`), or while its agent
 * has a blocking request open (it counts cases, not decisions); once the run ended, an open case is "not finished".
 */
function planPart(c: TestCase, waiting: ReadonlySet<string>, ended: boolean): PlanPart {
  if (ended && (c.status === 'executing' || c.status === 'proposed')) return 'unfinished';
  if ((c.status === 'executing' || c.status === 'proposed') && waiting.has(`case:${c.id}`)) return 'waiting';
  switch (c.status) {
    case 'executed':
      return 'done';
    case 'executing':
      return waiting.has(c.agent) ? 'waiting' : 'running';
    case 'skipped':
      return 'skipped';
    case 'blocked':
      return 'blocked';
    default:
      return 'queued';
  }
}

export function PlanPanel({
  cases,
  waiting,
  ended,
}: {
  readonly cases: readonly TestCase[];
  readonly waiting: ReadonlySet<string>;
  readonly ended: boolean;
}) {
  const counts = new Map<PlanPart, number>();
  for (const c of cases) counts.set(planPart(c, waiting, ended), (counts.get(planPart(c, waiting, ended)) ?? 0) + 1);
  const parts = PLAN_PARTS.filter((p) => (counts.get(p.key) ?? 0) > 0 || p.key === 'done' || (p.key === 'queued' && !ended));
  return (
    <section aria-labelledby="plan-h">
      <h2 id="plan-h" className="mb-2 flex items-baseline text-[12.5px] font-semibold">
        Test plan
        <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">
          {cases.length === 0 ? 'not recorded yet' : `${cases.length} ${cases.length === 1 ? 'case' : 'cases'}`}
        </span>
      </h2>
      {cases.length === 0 ? (
        <p className="m-0 text-[12px] leading-[18px] text-muted-foreground">The planner records the test plan after recon maps the site.</p>
      ) : (
        <>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-[4px]" aria-hidden="true">
            {PLAN_PARTS.map((p) =>
              (counts.get(p.key) ?? 0) === 0 ? null : (
                <b key={p.key} className="block h-full" style={{ width: `${((counts.get(p.key) ?? 0) / cases.length) * 100}%`, background: p.colour }} />
              ),
            )}
          </div>
          <dl className="m-0 mt-2 grid grid-cols-2 gap-x-3 gap-y-[3px] text-[11.5px] text-muted-foreground">
            {parts.map((p) => (
              <div key={p.key} className="flex items-center gap-1.5">
                <i aria-hidden="true" className="inline-block size-2 rounded-[2px]" style={{ background: p.colour }} />
                <dt>{p.label}</dt>
                <dd className="m-0 ml-auto font-semibold text-foreground tabular-nums">{counts.get(p.key) ?? 0}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

function Verdict({ c }: { readonly c: Candidate }) {
  if (c.status === 'validating')
    return (
      <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-medium text-slate">
        <span aria-hidden="true" className="size-2.5 rounded-full border-2 border-current border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]" />
        Proving, {Math.min(c.replays, VALIDATOR_REPLAYS)} of {VALIDATOR_REPLAYS}
      </span>
    );
  const verdict = c.status === 'released' ? 'released' : c.status === 'not_confirmed' ? 'suspected' : c.status;
  // Kept back is a settled verdict: a flat dash, never a ring that reads as "still working".
  if (verdict === 'suspected')
    return (
      <span className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
        <span aria-hidden="true" className="h-[2px] w-2.5 rounded-full bg-current" />
        Kept back
      </span>
    );
  return (
    <span className="ml-auto">
      <VerdictMark verdict={verdict} />
    </span>
  );
}

export function FoundPanel({
  items,
  ended = false,
  release = 'hold',
}: {
  readonly items: readonly Candidate[];
  readonly ended?: boolean;
  /** The request's release mode: proven issues wait for a person, or release themselves. */
  readonly release?: 'hold' | 'auto';
}) {
  return (
    <section aria-labelledby="found-h">
      <h2 id="found-h" className="mb-2 flex min-w-0 items-baseline gap-2 text-[12.5px] font-semibold">
        <span className="shrink-0 whitespace-nowrap">{ended ? 'Found' : 'Found so far'}</span>
        <span className="ml-auto min-w-0 truncate text-right text-[11.5px] font-normal text-muted-foreground">
          {release === 'auto' ? 'proven issues release themselves' : 'private until you release'}
        </span>
      </h2>
      {items.length === 0 ? (
        <p className="m-0 text-[12px] leading-[18px] text-muted-foreground">
          Nothing yet. Every suspected issue is replayed by the validator before it counts.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((c) => (
            <li key={c.candidateId} className="rounded-[10px] border border-border px-2.5 py-2 text-[12.5px] leading-[18px]">
              <div className="mb-[3px] flex items-center gap-1.5 text-[11px]">
                <SeverityChip severity={c.severity} />
                <Verdict c={c} />
              </div>
              {c.findingId === null ? (
                <span>{c.title}</span>
              ) : (
                <Link href={`/findings/${c.findingId}`} prefetch={false} className="text-foreground no-underline hover:underline">
                  {c.title}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const CASE_WORD: Readonly<Record<string, { label: string; cls: string }>> = {
  executed: { label: 'Done', cls: 'bg-ok-soft text-ok' },
  executing: { label: 'Running', cls: 'bg-slate-soft text-slate' },
  proposed: { label: 'Queued', cls: 'bg-surface-2 text-muted-foreground' },
  skipped: { label: 'Skipped', cls: 'bg-surface-2 text-muted-foreground' },
  blocked: { label: 'Blocked', cls: 'bg-warn-soft text-warn' },
};

/** The Test plan tab: every case the planner recorded, who it went to and where it stands. */
export function TestPlanTab({
  cases,
  waiting,
  ended,
}: {
  readonly cases: readonly TestCase[];
  readonly waiting: ReadonlySet<string>;
  readonly ended: boolean;
}) {
  if (cases.length === 0)
    return (
      <p className="m-0 rounded-[14px] border border-dashed border-border-strong px-5 py-6 text-[13px] text-muted-foreground">
        No test plan yet. The planner records it once recon has mapped the site.
      </p>
    );
  return (
    <Card as="section" aria-label="Test plan">
      <ol className="m-0 list-none divide-y divide-border p-0">
        {cases.map((c) => {
          const part = planPart(c, waiting, ended);
          const word =
            part === 'waiting'
              ? { label: 'Held for a decision', cls: 'bg-gold-soft text-gold-ink' }
              : part === 'unfinished'
                ? { label: 'Not finished', cls: 'bg-surface-2 text-muted-foreground' }
                : (CASE_WORD[c.status] ?? CASE_WORD.proposed);
          return (
            <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-2.5 text-[13px]">
              <span className="min-w-0">
                <span className="font-medium">{c.title === '' ? c.id : c.title}</span>
                <span className="block truncate text-[11.5px] text-muted-foreground">
                  <span className="font-mono">{c.id}</span>
                  {c.agent === '' ? '' : ` · ${agentName(c.agent)}`}
                  {c.target === '' ? '' : ` · ${c.target}`}
                  {c.note === '' ? '' : ` · ${c.note}`}
                </span>
              </span>
              <span className={`inline-flex h-[22px] items-center gap-1 rounded-md px-2 text-[11.5px] font-medium ${word?.cls ?? ''}`}>
                {word?.label === 'Done' ? <Icon name="check" size={11} /> : null}
                {word?.label}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** The same status pill as the conversation's call rows. */
export function statusTone(status: number): string {
  if (status === 0 || status >= 500) return 'bg-bad-soft text-bad';
  if (status >= 300) return 'bg-med-soft text-med';
  return 'bg-ok-soft text-ok';
}

const OUTCOME_CLS: Readonly<Record<string, string>> = {
  sent: '',
  blocked: 'text-warn',
  denied: 'text-warn',
  error: 'text-bad',
};

/** The Requests tab: every request the runner recorded, newest last; a row opens the request and response. */
export function RequestsTab({
  items,
  state,
  onOpen,
  onRetry,
}: {
  readonly items: readonly Exchange[];
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly onOpen: (id: string) => void;
  readonly onRetry: () => void;
}) {
  if (state === 'error' && items.length === 0)
    return (
      <p role="alert" className="m-0 text-[13px] text-bad">
        Couldn&apos;t load the requests.{' '}
        <button type="button" onClick={onRetry} className="font-medium underline">
          Retry
        </button>
      </p>
    );
  if (items.length === 0)
    return (
      <p className="m-0 rounded-[14px] border border-dashed border-border-strong px-5 py-6 text-[13px] text-muted-foreground">
        {state === 'ready' ? 'No request has been sent yet.' : 'Loading the recorded requests…'}
      </p>
    );
  return (
    <Card as="section" aria-label="Requests">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-[12px] text-muted-foreground">
        <span>
          {items.length.toLocaleString('en-US')} recorded {items.length === 1 ? 'request' : 'requests'}
        </span>
        <span>Bodies are excerpts. Credentials are redacted.</span>
      </div>
      <ol className="m-0 list-none divide-y divide-border p-0">
        {items.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              onClick={() => {
                onOpen(x.id);
              }}
              className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 text-left text-[12.5px] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-focus max-md:min-h-11 md:grid-cols-[84px_minmax(120px,max-content)_minmax(0,1fr)_auto_64px]"
            >
              <time dateTime={x.at} className="font-mono text-[11px] text-muted-foreground">
                {localClock(x.at)}
              </time>
              <span className="hidden truncate md:inline">{agentName(x.agent)}</span>
              <span className="min-w-0 truncate font-mono text-[12px]">
                <span className="font-medium text-slate">{x.method}</span> {withRedactions(pathOf(x.url))}
              </span>
              {x.outcome === 'sent' && x.status !== null ? (
                <span className={`justify-self-end rounded-[5px] px-1.5 py-px text-[10.5px] font-medium tabular-nums ${statusTone(x.status)}`}>{x.status}</span>
              ) : (
                <span className={`text-[11.5px] font-medium ${OUTCOME_CLS[x.outcome] ?? ''}`}>
                  {x.outcome === 'blocked' ? 'Blocked' : x.outcome === 'denied' ? 'Denied' : 'Failed'}
                </span>
              )}
              <span className="hidden text-right text-[11px] text-muted-foreground md:inline">
                {x.durationMs === null ? '' : `${x.durationMs} ms`}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}

const LANE_H = 56;

function MarkShapeSvg({ shape }: { readonly shape: MarkShape }) {
  switch (shape) {
    case 'circle':
      return <circle r="3" style={{ fill: 'var(--slate)' }} />;
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
          style={{ fill: 'var(--gold)' }}
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

/** Flight deck lanes: one row per agent of the manifest, its marks over the last 2 minutes. */
function AgentLanes({
  lanes,
  nowMs,
  running,
  pausedFrom,
  startMs,
}: {
  readonly lanes: readonly AgentLane[];
  readonly nowMs: number;
  readonly running: boolean;
  /** Per agent: epoch ms since when the lane is paused (Gate 2 wait or run paused). */
  readonly pausedFrom: (agent: string) => number | null;
  /** When the run started: a finished run's lanes span the whole run, not its last 2 minutes. */
  readonly startMs: number;
}) {
  const spanMs = running ? LANE_WINDOW_S * 1000 : Math.max(LANE_WINDOW_S * 1000, nowMs - startMs);
  const from = nowMs - spanMs;
  const pct = (t: number): number => ((t - from) / spanMs) * 100;
  const span = running ? 'last 2 minutes' : `the whole run (${Math.max(1, Math.round(spanMs / 60_000))} min)`;
  return (
    <Card aria-label="Agent lanes" as="div">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Agent lanes</h2>
        <span className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <Legend shape="circle" label="HTTP request" />
          <Legend shape="square" label="Tool call" />
          <Legend shape="ring" label="Blocked by scope" />
          <Legend shape="diamond" label="Candidate finding" />
          <span>{span.charAt(0).toUpperCase() + span.slice(1)}</span>
        </span>
      </div>
      {lanes.map((lane) => {
        const since = pausedFrom(lane.name);
        const paused = since !== null;
        return (
          <div
            key={lane.name}
            className="grid grid-cols-[200px_minmax(0,1fr)] border-b border-border lg:grid-cols-[300px_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 flex-col gap-0.5 border-r border-border px-4 py-2.5">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${paused ? 'bg-gold' : running ? 'bg-slate motion-safe:animate-[bwpulse_1.6s_ease-in-out_infinite]' : 'bg-muted-foreground'}`}
                />
                <span className="min-w-0 truncate text-[13px] font-medium">{agentName(lane.name)}</span>
                <span className="ml-auto hidden whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground lg:inline">
                  {lane.deterministic
                    ? 'replay engine'
                    : `${lane.turns} turns, $${lane.costUsd.toFixed(2)}`}
                </span>
              </span>
              {/* The mono id is never cut; the latest words give way. A lane that has only used tools so far shows
                  its latest request instead of "no message". */}
              <span
                title={lane.task === '' ? lane.last : stripMarkdown(lane.task)}
                className={`flex min-w-0 items-baseline gap-1 text-[12.5px] ${paused ? 'text-gold-ink' : 'text-muted-foreground'}`}
              >
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{lane.name} ·</span>
                <span className="min-w-0 truncate">
                  {paused ? 'Waiting. ' : ''}
                  {lane.task !== '' ? stripMarkdown(lane.task) : lane.last !== '' ? `Latest request: ${lane.last}` : 'Nothing yet'}
                </span>
              </span>
            </div>
            <svg
              width="100%"
              height={LANE_H}
              role="img"
              aria-label={`${agentName(lane.name)} activity, ${span}`}
              className="block bg-surface"
            >
              <defs>
                <pattern
                  id={`hatch-${lane.name}`}
                  width="12"
                  height="12"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="12" style={{ fill: 'var(--gold-soft)' }} />
                </pattern>
              </defs>
              {paused ? (
                <rect
                  x={`${Math.max(0, pct(since))}%`}
                  y="4"
                  width={`${Math.max(0, 100 - Math.max(0, pct(since)))}%`}
                  height={LANE_H - 8}
                  style={{ fill: `url(#hatch-${lane.name})` }}
                />
              ) : null}
              {paused ? (
                <rect
                  x={`${Math.max(0, pct(since))}%`}
                  y="4"
                  width="2"
                  height={LANE_H - 8}
                  style={{ fill: 'var(--gold-ink)' }}
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
              <line
                x1="100%"
                x2="100%"
                y1="0"
                y2={LANE_H}
                strokeWidth="2"
                style={{ stroke: 'var(--gold-ink)' }}
              />
            </svg>
          </div>
        );
      })}
      <div className="grid grid-cols-[200px_minmax(0,1fr)] py-1.5 text-[11px] text-muted-foreground lg:grid-cols-[300px_minmax(0,1fr)]">
        <span />
        <span className="flex justify-between pr-2">
          {running ? (
            <>
              <span>2 min ago</span>
              <span>90 s</span>
              <span>60 s</span>
              <span>30 s</span>
              <span className="font-medium text-gold-ink">Now</span>
            </>
          ) : (
            // A finished run: its start, its quarters and its end, in minutes from the start.
            [0, 0.25, 0.5, 0.75, 1].map((q) => (
              <span key={q} className={q === 1 ? 'font-medium text-foreground' : ''}>
                {q === 0 ? 'Start' : q === 1 ? 'End' : `${Math.round((spanMs * q) / 60_000)} min`}
              </span>
            ))
          )}
        </span>
      </div>
    </Card>
  );
}

const FILTERS = ['Everything', 'Requests', 'Blocked and decisions', 'Errors only'] as const;
type Filter = (typeof FILTERS)[number];

const KIND_TAG: Record<Activity['kind'], { kind: string; label: string }> = {
  HTTP: { kind: 'http', label: 'HTTP' },
  Tool: { kind: 'tool', label: 'Tool' },
  Policy: { kind: 'blocked', label: 'Blocked' },
  'Gate 2': { kind: 'gate2', label: 'Decision' },
  Finding: { kind: 'finding', label: 'Finding' },
  Validator: { kind: 'tool', label: 'Validator' },
  Agent: { kind: 'http', label: 'Agent' },
  Run: { kind: 'http', label: 'Run' },
};

function passes(filter: Filter, row: Activity): boolean {
  if (filter === 'Requests') return row.kind === 'HTTP';
  if (filter === 'Blocked and decisions') return row.kind === 'Policy' || row.kind === 'Gate 2';
  if (filter === 'Errors only') return row.isError;
  return true;
}

function ActivityTable({ rows }: { readonly rows: readonly Activity[] }) {
  const [filter, setFilter] = useState<Filter>('Everything');
  const shown = rows
    .filter((r) => passes(filter, r))
    .slice(-100)
    .reverse();
  return (
    <Card aria-labelledby="activity-h" as="section" className="self-start">
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
              className={`inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${filter === f ? 'border-border bg-surface text-foreground shadow-[0_1px_2px_rgba(23,21,15,.06)]' : 'border-transparent bg-surface-2 text-muted-foreground hover:text-foreground'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted-foreground">Nothing to show yet.</p>
      ) : (
        // The tab pane already scrolls: no scroll box inside it.
        <ol className="divide-y divide-border">
          {shown.map((r) => (
            <li
              key={r.seq}
              className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-4 py-[9px] text-[13px] md:grid-cols-[82px_150px_minmax(0,1fr)_auto]"
            >
              <time dateTime={r.at} className="font-mono text-[11.5px] text-muted-foreground">
                {localClock(r.at)}
              </time>
              <span className="truncate text-xs font-medium">{WHO[r.agent] ?? agentName(r.agent)}</span>
              <span className="col-start-2 flex min-w-0 items-center gap-2 md:col-start-auto">
                {/* Decisions are gold ("your turn"); warn stays for limits near their end. */}
                {r.kind === 'Gate 2' ? (
                  <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] bg-gold-soft px-2 text-[11px] font-medium text-gold-ink">
                    {KIND_TAG[r.kind].label}
                  </span>
                ) : (
                  <KindTag kind={KIND_TAG[r.kind].kind}>{KIND_TAG[r.kind].label}</KindTag>
                )}
                <span title={stripMarkdown(r.text)} className="truncate">
                  {stripMarkdown(r.text)}
                </span>
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

function SummaryCard({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card as="section" aria-labelledby="summary-h" className="p-4">
      <h2 id="summary-h" className="mb-2 text-sm font-semibold">
        The planner&apos;s summary <span className="font-normal text-muted-foreground">· Claude, not verified</span>
      </h2>
      <div className={open ? '' : 'max-h-36 overflow-hidden'}>
        <Markdown text={text} className="text-[13.5px] leading-6" />
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="mt-2 text-[13px] font-medium text-gold-ink hover:underline"
      >
        {open ? 'Show less' : 'Show all'}
      </button>
    </Card>
  );
}


/** The Flight deck tab: the lanes, the raw activity and, once written, the planner's summary. */
export function FlightDeck({
  lanes,
  rows,
  nowMs,
  running,
  pausedFrom,
  summary,
  startMs,
}: {
  readonly lanes: readonly AgentLane[];
  readonly rows: readonly Activity[];
  readonly nowMs: number;
  readonly running: boolean;
  readonly pausedFrom: (agent: string) => number | null;
  readonly summary: string | null;
  readonly startMs: number;
}) {
  return (
    <div className="flex flex-col gap-3">
      {lanes.length === 0 ? null : <AgentLanes lanes={lanes} nowMs={nowMs} running={running} pausedFrom={pausedFrom} startMs={startMs} />}
      <ActivityTable rows={rows} />
      {summary === null ? null : <SummaryCard text={summary} />}
    </div>
  );
}
