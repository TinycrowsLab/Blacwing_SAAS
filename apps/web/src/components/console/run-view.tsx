/* Presentational values (poll intervals, widths) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Watch Blackwing work (experience spec §5): the live audit. The first render comes from the server; the client polls the
// run route (afterSeq) at once on mount (a cached first paint after Back must not pose as the present), then every 1.5 s
// while the tab is visible, backs off on failure (1.5, 3, 6, 10 s) and keeps the data it has. Everything shown is
// derived from the run DTO and its events in run-model.ts. The open tab and agent filter live in the URL, so Back
// returns to the same view.
// shortcut: polling, not SSE; upgrade when the API gains an event stream.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
} from '@blackwing/ui';

import { Conversation, shortTime } from './conversation';
import { AuthorisedUnder, buttonClass, Icon, VoiceTag, withRedactions } from './design';
import { CLOCK_TONE, PendingButton, useCountdown } from './design-client';
import {
  AccountsPanel,
  CandidatesSummary,
  FlightDeck,
  FoundPanel,
  LimitsPanel,
  PlanPanel,
  RequestsTab,
  TestCasesSummary,
  TestPlanTab,
} from './flight-deck';
import { plainWhy } from './gate2-view';
import { KillButton } from './kill-dialog';
import { Modal } from './modal';
import { runAgainAction } from './results/actions';
import { RunAgain } from './results/report-download';
import { ExchangeSheet, RunDetailsSheet } from './run-details-sheet';
import {
  type Exchange,
  TERMINAL_STATES,
  accountUse,
  agentLanes,
  blockingAsks,
  candidates,
  caseList,
  conversationItems,
  describe,
  exchangeListSchema,
  filterConversation,
  hms,
  isOpenGate2,
  liveness,
  manifest,
  mergeEvents,
  modelLabel,
  pathOf,
  stages,
  teamNodes,
} from './run-model';
import { StageSpine } from './stage-spine';
import { TeamMap } from './team-map';
import { useNow } from './use-now';
import { agentName } from '../../lib/agents';
import { decisionTitle } from '../../lib/plan-text';
import { CARE_LABEL, type Gate2, pinnedAuthorisation, type Run, type RunEvent, runSchema } from '../../lib/schemas';

const BACKOFF_MS = [1500, 3000, 6000, 10_000] as const;
/** Pause and Resume give up after this long, so the answer (or the error) lands inside the 2 s budget. */
const CONTROL_TIMEOUT_MS = 1500;
const MAP_KEY = 'bw.run.mapCollapsed';
const NETWORK_ERROR = "Couldn't reach Blackwing. Nothing changed. Try again.";
/** The Requests tab refreshes this often while it is open and the run is live. */
const EXCHANGES_REFRESH_MS = 5000;
/** The API returns at most this many exchanges per page (store EXCHANGE_PAGE). */
const EXCHANGE_PAGE = 200;

type Tab = 'conversation' | 'plan' | 'requests' | 'deck';
const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'plan', label: 'Test plan' },
  { id: 'requests', label: 'Requests' },
  { id: 'deck', label: 'Flight deck' },
];

function hostOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The recorded exchanges, loaded page by page on demand (Requests tab, call sheet) and topped up while live. */
function useExchanges(runId: string) {
  const [items, setItems] = useState<Exchange[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const lastSeq = useRef(0);
  const busy = useRef<Promise<Exchange[] | null> | null>(null);

  const load = useCallback((): Promise<Exchange[] | null> => {
    if (busy.current !== null) return busy.current;
    setState((s) => (s === 'ready' ? s : 'loading'));
    const run = async (): Promise<Exchange[] | null> => {
      const all: Exchange[] = [];
      try {
        for (;;) {
          const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/exchanges?afterSeq=${lastSeq.current}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          const page = exchangeListSchema.parse(await res.json());
          all.push(...page.items);
          lastSeq.current = Math.max(lastSeq.current, page.lastSeq);
          if (page.items.length < EXCHANGE_PAGE) break;
        }
        setItems((prev) => [...prev, ...all.filter((x) => !prev.some((p) => p.id === x.id))]);
        setState('ready');
      } catch {
        setState('error');
        return null;
      } finally {
        busy.current = null;
      }
      return all;
    };
    busy.current = run();
    return busy.current;
  }, [runId]);
  return { items, state, load };
}

function readMapCollapsed(): boolean {
  try {
    // Calm by default: the team map starts collapsed until the person chooses to keep it open ('0' is stored only
    // when they expand it), so the conversation has the room and the page is not busy on first open.
    return window.localStorage.getItem(MAP_KEY) !== '0';
  } catch {
    return true;
  }
}

function Liveness({
  tone,
  text,
  short,
  className = '',
}: {
  readonly tone: 'live' | 'quiet' | 'reconnecting';
  readonly text: string;
  /** Phones: the one-word form beside the state pill. */
  readonly short?: string;
  readonly className?: string;
}) {
  const dot = tone === 'live' ? 'bg-ok motion-safe:animate-[bwpulse_1.6s_ease-in-out_infinite]' : tone === 'quiet' ? 'bg-faint' : 'bg-warn';
  return (
    <span
      role="status"
      className={`flex items-center gap-1.5 whitespace-nowrap text-[11.5px] ${tone === 'reconnecting' ? 'text-warn' : 'text-muted-foreground'} ${className}`}
    >
      <span aria-hidden="true" className={`size-[7px] rounded-full ${dot}`} />
      {short ?? text}
    </span>
  );
}

/**
 * The first open decision, pinned under the top bar on every width: who asks, the request, why it is outside the
 * authorisation (wider screens) and the live clock. Same clock (and rounding) as the decision card.
 */
function DecisionBanner({ g, more }: { readonly g: Gate2; readonly more: number }) {
  const clock = useCountdown(g.deadlineAt, g.createdAt);
  return (
    <Link
      href={`/decisions/gate2/${g.id}`}
      className="flex min-h-12 items-center gap-2.5 border-b border-gold-line bg-gold-soft px-4 py-1.5 text-[13px] text-foreground no-underline md:px-6"
    >
      <Icon name="hand" size={16} className="shrink-0 text-gold-ink" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold md:hidden">{decisionTitle(g.method, g.url)}</span>
        <span className="hidden truncate md:block">
          <b className="font-semibold">{agentName(g.agent)} asks to send</b>{' '}
          <span className="font-mono text-[12.5px]">
            {g.method} {withRedactions(pathOf(g.url))}
          </span>
        </span>
        <span className="block truncate text-[11.5px] text-muted-foreground">
          <span className="md:hidden">{agentName(g.agent)}</span>
          {g.whyOutside === '' ? null : <span className="max-md:hidden">{plainWhy(g.whyOutside)}</span>}
          {more > 0 ? ` · +${more} more` : ''}
        </span>
      </span>
      {/* The card's colours for the same clock: gold, amber under 5 min, red with a pulse in the last minute. */}
      <span className={`font-semibold tabular-nums ${CLOCK_TONE[clock?.tone ?? 'normal']}`}>
        {clock === null ? null : (
          <>
            {clock.label}
            <span className="text-[11.5px] font-normal text-muted-foreground max-md:hidden"> left</span>
          </>
        )}
      </span>
      <span className={buttonClass('primary', 'h-11 px-3.5 md:h-9')}>
        <span className="md:hidden">Decide</span>
        <span className="max-md:hidden">Review</span>
      </span>
    </Link>
  );
}

/**
 * The first render could not get the run (Blackwing was busy or did not answer in time): the page still opens, says
 * so calmly, and keeps trying with the same back-off as the live poll.
 */
/** Honest queue copy: who is running, where this audit stands, and that nothing has reached the site. */
function queueCopy(q: { readonly position: number; readonly ahead: number; readonly running: number; readonly concurrency: number }): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const running = q.running > 0 ? `${plural(q.running, 'audit is', 'audits are')} running (Blackwing runs ${q.concurrency} at a time). ` : `Blackwing runs ${q.concurrency} at a time. `;
  const place =
    q.ahead === 0
      ? 'Yours is next and starts as soon as a slot frees.'
      : `Yours is number ${q.position} in line: ${plural(q.ahead, 'audit waits', 'audits wait')} ahead of it.`;
  return `${running}${place} Nothing has been sent to the site yet.`;
}

export function RunViewLoader({ id, viewerName }: { readonly id: string; readonly viewerName: string | null }) {
  const [run, setRun] = useState<Run | null>(null);
  const [missing, setMissing] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    let timer = 0;
    let n = 0;
    const attempt = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(id)}?afterSeq=0`, { cache: 'no-store' });
        if (res.status === 404) {
          if (live) setMissing(true);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const next = runSchema.parse(await res.json());
        if (live) setRun(next);
      } catch {
        n += 1;
        if (!live) return;
        setTries(n);
        timer = window.setTimeout(() => void attempt(), BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0]);
      }
    };
    void attempt();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id]);
  if (run !== null) return <RunView initial={run} viewerName={viewerName} />;
  return (
    <section role="status" className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      {missing ? (
        <>
          <h1 className="m-0 text-[22px] font-semibold leading-8">We couldn&apos;t find that audit</h1>
          <p className="m-0 text-[14px] leading-6 text-muted-foreground">The link may be old, or the audit belongs to another workspace.</p>
          <Link href="/" className={buttonClass('primary')}>
            Go to Home
          </Link>
        </>
      ) : (
        <>
          <span aria-hidden="true" className="size-5 rounded-full border-2 border-border-strong border-t-gold-ink motion-safe:animate-[bwspin_0.9s_linear_infinite]" />
          <h1 className="m-0 text-[18px] font-semibold leading-7">Opening the audit…</h1>
          <p className="m-0 text-[13.5px] leading-6 text-muted-foreground">
            {tries === 0 ? 'Loading the latest from Blackwing.' : 'Blackwing is busy for a moment. Reconnecting…'} The audit keeps running either way.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * A right-rail section the person can collapse. Collapsed it shows a compact one-line summary, so the busy run page
 * stays calm (the reference-style detail is one click away). Keeps its own open state per-section; the live findings
 * list is never wrapped in one, so results stay in view.
 */
function RailDisclosure({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-dashed border-border pb-3 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-baseline gap-2 rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
      >
        <span className="text-[12.5px] font-semibold text-foreground">{title}</span>
        {open ? null : <span className="ml-auto truncate text-[11.5px] font-normal text-muted-foreground tabular-nums">{summary}</span>}
        <Icon name="chevron" size={14} className={`${open ? 'ml-auto' : ''} shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </section>
  );
}

/** Two diagonal arrows: the "open full screen" affordance (no such glyph in the icon set). */
function ExpandIcon({ size = 14 }: { readonly size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />
    </svg>
  );
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function RunView({ initial, viewerName }: { readonly initial: Run; readonly viewerName: string | null }) {
  const params = useSearchParams();
  const [run, setRun] = useState<Run>(initial);
  const [events, setEvents] = useState<RunEvent[]>(initial.events);
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get('tab');
    return TABS.some((x) => x.id === t) ? (t as Tab) : 'conversation';
  });
  const [rawFilter, setFilter] = useState<string | null>(() => {
    const a = params.get('agent');
    return a !== null && AGENT_ID.test(a) ? a : null;
  });
  // Only an agent of this run filters (a stale or made-up ?agent= is ignored, and drops out of the URL).
  const agents = useMemo(() => manifest(events), [events]);
  const filter = rawFilter !== null && agents.includes(rawFilter) ? rawFilter : null;
  /** False until the first poll answered: the server's (maybe cached) first paint says nothing about "live". */
  const [synced, setSynced] = useState(false);
  const [failedSince, setFailedSince] = useState<number | null>(null);
  const [lastOk, setLastOk] = useState(() => Date.now());
  const [controlError, setControlError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [team, setTeam] = useState(false);
  const [panel, setPanel] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mapCollapsed, setMapCollapsed] = useState(false);
  // Focus mode: the active tab (conversation or flight deck) opens full screen, so the person can read one thing with
  // nothing else around it.
  const [focusTab, setFocusTab] = useState(false);
  const [showDecision, setShowDecision] = useState(0);
  const moreRef = useRef<HTMLButtonElement>(null);
  const callOrigin = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [openCall, setOpenCall] = useState<{ id: string; state: 'loading' | 'ready' | 'missing' | 'error' } | null>(null);
  const lastSeq = useRef(initial.lastSeq);
  const failures = useRef(0);
  const terminal = TERMINAL_STATES.has(run.state);
  const nowMs = useNow(true, 1000);
  const exchanges = useExchanges(run.id);

  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(initial.id)}?afterSeq=${lastSeq.current}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const next = runSchema.parse(await res.json());
      lastSeq.current = Math.max(lastSeq.current, next.lastSeq);
      // Back online: an earlier "couldn't reach" message no longer holds.
      if (failures.current > 0) setControlError((e) => (e === NETWORK_ERROR ? null : e));
      failures.current = 0;
      setFailedSince(null);
      setLastOk(Date.now());
      setSynced(true);
      setRun(next);
      if (next.events.length > 0) setEvents((prev) => mergeEvents(prev, next.events));
      return true;
    } catch {
      failures.current += 1;
      setFailedSince((s) => s ?? Date.now());
      return false;
    }
  }, [initial.id]);

  // A first paint from the router cache (Back, a revisit) may be minutes old: catch up at once, live or not.
  useEffect(() => {
    void poll();
  }, [poll]);

  // The view (tab, agent filter) is kept in the URL without a navigation, so Back and a shared link reopen it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === 'conversation') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    if (filter === null) url.searchParams.delete('agent');
    else url.searchParams.set('agent', filter);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [tab, filter]);

  // One timer chain: 1.5 s while healthy, backing off after failures, paused while the tab is hidden.
  useEffect(() => {
    if (terminal) return;
    let timer = 0;
    let stopped = false;
    const schedule = (): void => {
      const delay = BACKOFF_MS[Math.min(failures.current, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
      timer = window.setTimeout(() => {
        if (document.visibilityState !== 'visible') return;
        void poll().then(() => {
          if (!stopped) schedule();
        });
      }, delay);
    };
    const now = (): void => {
      window.clearTimeout(timer);
      void poll().then(() => {
        if (!stopped) schedule();
      });
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') now();
    };
    // Back online: catch up at once instead of waiting out the back-off.
    const onOnline = (): void => {
      if (document.visibilityState === 'visible') now();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [terminal, poll]);

  // A run that just ended: the sidebar catches up now, not at its next poll.
  const wasTerminal = useRef(terminal);
  useEffect(() => {
    if (terminal && !wasTerminal.current) window.dispatchEvent(new Event('bw:refresh'));
    wasTerminal.current = terminal;
  }, [terminal]);

  // The Stop dialog (and anything else that changes the run) asks for an immediate refresh, so the page behind the
  // halt view catches up at once instead of on the next poll.
  useEffect(() => {
    const now = (): void => {
      void poll();
    };
    window.addEventListener('bw:refresh', now);
    return () => {
      window.removeEventListener('bw:refresh', now);
    };
  }, [poll]);

  useEffect(() => {
    setMapCollapsed(readMapCollapsed());
  }, []);

  // The Requests tab stays current while it is open.
  useEffect(() => {
    if (tab !== 'requests') return;
    const { load } = exchanges;
    void load();
    if (terminal) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, EXCHANGES_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [tab, terminal, exchanges.load]);

  const { items: exchangeItems, load: loadExchanges } = exchanges;
  const openExchange = useCallback(
    (id: string): void => {
      // Closing the sheet returns the keyboard to the row that opened it.
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) callOrigin.current = document.activeElement;
      if (exchangeItems.some((x) => x.id === id)) {
        setOpenCall({ id, state: 'ready' });
        return;
      }
      setOpenCall({ id, state: 'loading' });
      void loadExchanges().then((fresh) => {
        setOpenCall((cur) =>
          cur?.id !== id ? cur : { id, state: fresh === null ? 'error' : fresh.some((x) => x.id === id) ? 'ready' : 'missing' },
        );
      });
    },
    [exchangeItems, loadExchanges],
  );

  async function control(action: 'pause' | 'resume'): Promise<void> {
    setControlError(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/${action}`, {
        method: 'POST',
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { message?: unknown };
        setControlError(typeof problem.message === 'string' ? problem.message : `Couldn't ${action} the audit. Try again.`);
        return;
      }
      await poll();
      window.dispatchEvent(new Event('bw:refresh'));
    } catch {
      // shortcut: a timed-out request may still land on the server; the next poll shows the real state either way.
      setControlError(NETWORK_ERROR);
    }
  }

  // ---- derived -----------------------------------------------------------------------------------------------------
  const host = hostOf(run.pins.asset?.baseUrl) ?? run.pins.asset?.name ?? 'Audit';
  const care = run.pins.request?.intrusiveness ?? '';
  const pinnedRequest = run.pins.request as { releaseProven?: unknown; decidedAt?: unknown } | undefined;
  const release = pinnedRequest?.releaseProven === 'auto' ? 'auto' : 'hold';
  const approvedAt = typeof pinnedRequest?.decidedAt === 'string' ? pinnedRequest.decidedAt : null;
  const approver = run.pins.authorisation?.signedBy ?? null;
  const approvedBy = approver === null ? null : approver === viewerName ? 'you' : approver;
  const mounted = nowMs > 0;

  // The decision list is a new array on every poll; keep its identity while its content is the same so the
  // conversation (memoised) re-renders only when something changed.
  const gate2Key = JSON.stringify(run.gate2);
  const gate2 = useMemo(() => run.gate2, [gate2Key]);
  const stopped = run.state === 'killed' || run.state === 'failed';
  const items = useMemo(() => conversationItems(events, gate2, viewerName, run.findings), [events, gate2, viewerName, run.findings]);
  const shownItems = useMemo(() => (filter === null ? items : filterConversation(items, filter)), [items, filter]);
  // Review is complete once every proven finding is released or dismissed. Kept-back (unproven) findings never block it:
  // they stay out of the report by default.
  const reviewed =
    run.state === 'completed' &&
    run.findings.some((f) => f.status === 'released' || f.status === 'dismissed') &&
    !run.findings.some((f) => f.status === 'confirmed');
  const spine = useMemo(() => stages(events, { terminal, approvedBy, stopped, reviewed }), [events, terminal, approvedBy, stopped, reviewed]);
  const teamMap = useMemo(
    () => teamNodes(events, gate2, nowMs, terminal, stopped, run.paused),
    [events, gate2, nowMs, terminal, stopped, run.paused],
  );
  const cases = useMemo(() => caseList(events), [events]);
  const cands = useMemo(() => candidates(events, { terminal, findings: run.findings }), [events, terminal, run.findings]);
  const pending = run.gate2.filter((g) => isOpenGate2(g, nowMs));
  const pendingIds = pending.map((g) => g.id).join(',');
  // Only an ask the runner waits on holds its agent; a non-blocking ask leaves it testing other cases.
  const waitingAgents = useMemo(
    () => new Set(pendingIds === '' ? [] : blockingAsks(events, run.gate2.filter((g) => pendingIds.includes(g.id))).map((g) => g.agent)),
    [pendingIds, run.gate2, events],
  );
  // The test plan also holds each case an open request names (`case:<id>`), blocking or not.
  const heldCases = useMemo(() => {
    const held = new Set(waitingAgents);
    for (const e of events)
      if (e.kind === 'gate2.requested' && typeof e.data.caseId === 'string' && pendingIds.includes(String(e.data.gate2Id)))
        held.add(`case:${e.data.caseId}`);
    return held;
  }, [waitingAgents, events, pendingIds]);
  // The sidebar's "Waiting on you" polls every 5 s: when this run's open decisions change, it refreshes now, so the two
  // counts never disagree on screen.
  const firstPending = useRef(true);
  useEffect(() => {
    if (firstPending.current) {
      firstPending.current = false;
      return;
    }
    window.dispatchEvent(new Event('bw:refresh'));
  }, [pendingIds]);
  const stopping = !terminal && events.some((e) => e.kind === 'kill.requested');
  const model = modelLabel(events);

  // Every clock starts when the run started: a queued run has no elapsed time and is never "quiet".
  const router = useRouter();
  const queued = run.state === 'queued';
  const startedMs = run.startedAt === null ? null : new Date(run.startedAt).getTime();
  const end = run.finishedAt === null ? (mounted ? nowMs : (startedMs ?? 0)) : new Date(run.finishedAt).getTime();
  const start = startedMs ?? end;
  const elapsedS = Math.max(0, (end - start) / 1000);
  const lastEvent = events.findLast((e) => startedMs === null || Date.parse(e.at) >= startedMs);
  const polled = liveness(nowMs, lastEvent === undefined ? start : Date.parse(lastEvent.at), failedSince, lastOk);
  // Paused is not "live": no new request goes out. A failing poll still says so first.
  const live = run.paused && polled.tone !== 'reconnecting' ? { tone: 'quiet' as const, text: 'Paused · no new requests', short: 'Paused' } : polled;
  const waitsText = `${pending.length} ${pending.length === 1 ? 'decision waits' : 'decisions wait'} for you`;
  const resultsHref = `/runs/${encodeURIComponent(run.id)}/results`;
  // Cases the run never finished: the "Continue where it left off" menu item shows only when some are left.
  const untriedCount = run.coverage?.cases.filter((c) => c.status === 'not_run' || c.status === 'blocked').length ?? 0;

  // The pill names the same stage the spine marks current, so the two never disagree.
  const stage = spine.find((x) => x.state === 'current');
  const working = stage === undefined || stage.key === 'approved' ? 'Starting' : stage.key === 'review' ? 'Testing' : stage.label;
  const stateText = terminal
    ? run.state === 'completed'
      ? 'Finished'
      : run.state === 'killed'
        ? 'Stopped'
        : 'Stopped with an error'
    : stopping
      ? 'Stopping…'
      : queued
        ? 'Queued'
        : run.paused
          ? pending.length > 0
            ? `Paused · ${waitsText}`
            : 'Paused'
          : pending.length > 0
            ? `${working} · ${waitsText}`
            : working;
  const statePill =
    pending.length > 0 && !terminal ? 'border-gold-line bg-gold-soft text-gold-ink' : 'border-border bg-surface-2 text-foreground';

  const lanes = useMemo(() => agentLanes(events), [events]);
  // The runner saves its request count every few seconds; the events show each request as it goes. Both are real
  // counts of sent requests: show the higher, so the gauge never trails the spine.
  const sentCount = useMemo(() => events.filter((e) => e.kind === 'http.sent').length, [events]);
  const requestsUsed = Math.max(run.requestsUsed, sentCount);
  const rows = useMemo(() => events.flatMap((e) => describe(e) ?? []), [events]);
  const lastPause = events.findLast((e) => e.kind === 'run.paused');
  const pausedFrom = (agent: string): number | null => {
    const g = waitingAgents.has(agent) ? pending.find((x) => x.agent === agent) : undefined;
    if (g !== undefined) return g.createdAt === undefined ? end : new Date(g.createdAt).getTime();
    return run.paused && lastPause !== undefined ? new Date(lastPause.at).getTime() : null;
  };

  const gate1 = `${approvedBy === 'you' ? 'You' : (approver ?? 'Approved')}${approvedAt === null || !mounted ? '' : `, ${shortTime(approvedAt)}`}`;
  // Automatic when the request chose it, or when the events show a release nobody made by hand. A run that found
  // nothing leaves nothing to review: never a gold "your turn" for an empty result.
  // Only a proven issue still awaiting release is "your turn"; kept-back ones are kept out of the report by default.
  const toReviewNow = run.findings.some((f) => f.status === 'confirmed') || (run.findings.length === 0 && cands.some((c) => c.status === 'confirmed'));
  const gate3 = release === 'auto' || teamMap.autoReleased ? 'Automatic' : terminal ? (reviewed ? 'Review complete' : toReviewNow ? 'Your turn' : 'Nothing to review') : 'After the run';
  const onFilter = (a: string | null): void => {
    // The filter applies to whichever tab is open (the map sits above all of them).
    setFilter(a);
    setTeam(false);
  };
  // The agent filter applies to every tab, so "Showing one agent" is true wherever it shows.
  const shownCases = useMemo(() => (filter === null ? cases : cases.filter((c) => c.agent === filter)), [cases, filter]);
  // Memoised: the deck redraws its lanes and tables only when the events (or the filter) change, not on every tick.
  const shownLanes = useMemo(() => (filter === null ? lanes : lanes.filter((l) => l.name === filter)), [lanes, filter]);
  const shownRows = useMemo(() => (filter === null ? rows : rows.filter((r) => r.agent === filter)), [rows, filter]);
  const shownExchanges = filter === null ? exchanges.items : exchanges.items.filter((x) => x.agent === filter);
  const mapProps = { team: teamMap, gate1, gate3, ended: terminal, filter, onFilter };
  const onOpenPlan = useCallback((): void => {
    setTab('plan');
  }, []);
  const showPending = (): void => {
    setFilter(null);
    setTab('conversation');
    setShowDecision((n) => n + 1);
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS.at(-1) : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  };
  const autoRelease = release === 'auto' || teamMap.autoReleased;
  const roles = run.pins.request?.testAccounts?.map((a) => a.role) ?? run.coverage?.rolesConfigured ?? [];
  const used = accountUse(events);
  // Compact one-line summaries for the collapsed rail sections (the detail is one click away).
  const fmtMin = (s: number): string => (s < 60 ? `${Math.floor(s)}s` : `${Math.round(s / 60)}m`);
  const limitsSummary = `${fmtMin(elapsedS)} · ${requestsUsed.toLocaleString('en-US')} req · ${run.costUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
  const accountsTotal = roles.reduce((n, r) => n + (used.get(r) ?? 0), 0);
  const accountsSummary = `${roles.length} ${roles.length === 1 ? 'account' : 'accounts'} · ${accountsTotal.toLocaleString('en-US')} sent`;
  const doneCount = cases.filter((c) => c.status === 'executed').length;
  const planSummary = cases.length === 0 ? (terminal ? 'none recorded' : 'not recorded yet') : `${doneCount} of ${cases.length} done`;
  const sidePanel: ReactNode = (
    <>
      <RailDisclosure title="Limits you approved" summary={limitsSummary}>
        <LimitsPanel elapsedS={elapsedS} budget={run.budget} requestsUsed={requestsUsed} costUsd={run.costUsd} headless />
      </RailDisclosure>
      {roles.length === 0 ? null : (
        <RailDisclosure title="Account use" summary={accountsSummary}>
          <AccountsPanel roles={roles} used={used} warned={events.some((e) => e.kind === 'accounts.unused')} headless />
        </RailDisclosure>
      )}
      {/* Beside the flight deck the panel carries its test cases and candidate findings (design 1a), in its words. */}
      {tab === 'deck' ? (
        <>
          <TestCasesSummary cases={cases} bare ended={terminal} />
          <CandidatesSummary items={cands} release={autoRelease ? 'auto' : 'hold'} bare />
        </>
      ) : (
        <>
          <RailDisclosure title="Test plan" summary={planSummary} defaultOpen>
            <PlanPanel cases={cases} waiting={heldCases} ended={terminal} headless />
          </RailDisclosure>
          <FoundPanel items={cands} ended={terminal} release={autoRelease ? 'auto' : 'hold'} />
        </>
      )}
      <p className="m-0 mt-auto border-t border-dashed border-border-strong pt-2.5 text-[11px] leading-4 text-muted-foreground">
        Counts, limits and times come from the runner. Blackwing AI&apos;s messages are its own words and stay unverified until the
        validator proves them.
      </p>
    </>
  );
  // The active tab's content, defined once so it renders inline and, in focus mode, full screen.
  const tabContent: ReactNode =
    tab !== 'conversation' && !mounted ? null : tab === 'conversation' ? (
      <Conversation
        items={shownItems}
        gate2={gate2}
        viewerName={viewerName}
        resultsHref={resultsHref}
        onOpenCall={openExchange}
        onOpenPlan={onOpenPlan}
        showDecision={showDecision}
        waitingFirst={!terminal && !items.some((i) => i.type === 'turn' || i.type === 'thread')}
        emptyText={
          filter !== null
            ? `Nothing from the ${agentName(filter)} yet.`
            : terminal
              ? 'This run ended before any agent spoke.'
              : 'Waiting for the first agent…'
        }
      />
    ) : tab === 'plan' ? (
      <TestPlanTab
        cases={shownCases}
        waiting={heldCases}
        ended={terminal}
        filterName={filter === null ? null : agentName(filter)}
        total={cases.length}
        onClearFilter={() => {
          setFilter(null);
        }}
      />
    ) : tab === 'requests' ? (
      <RequestsTab
        items={shownExchanges}
        state={exchanges.state}
        onOpen={openExchange}
        onRetry={() => {
          void exchanges.load();
        }}
      />
    ) : (
      <FlightDeck
        lanes={shownLanes}
        rows={shownRows}
        cases={shownCases}
        candidates={cands}
        release={autoRelease ? 'auto' : 'hold'}
        nowMs={end}
        running={!terminal}
        pausedFrom={pausedFrom}
        summary={run.summary}
        startMs={start}
      />
    );
  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? 'View';
  const liveShown = !terminal && !queued && mounted && synced;
  const statePillEl: ReactNode =
    pending.length > 0 && !terminal ? (
      <button
        type="button"
        onClick={showPending}
        title="Show the decision"
        className={`inline-flex h-[26px] min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${statePill}`}
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-gold" />
        <span className="truncate">{stateText}</span>
        <Icon name="arrow" size={12} />
      </button>
    ) : (
      <span className={`inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12px] font-medium ${statePill}`}>
        {terminal ? null : <span aria-hidden="true" className="size-1.5 rounded-full bg-text" />}
        {stateText}
      </span>
    );
  const exchange = openCall === null ? null : (exchanges.items.find((x) => x.id === openCall.id) ?? null);
  const firstOpen = pending[0];
  const authorisation = pinnedAuthorisation(run.pins);

  return (
    <section
      aria-label={`Live audit of ${host}`}
      className="-mx-4 -my-5 flex h-[calc(100dvh-52px)] flex-col sm:-mx-6 md:-mx-8 md:-my-7 md:h-dvh"
    >
      {/* Header. Phones: the host and the 44 px controls share the first line, the state and liveness the second. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5 md:gap-y-2 md:px-6">
        <div className="min-w-0 flex-1">
          <nav aria-label="Breadcrumb" className="hidden text-[12px] text-muted-foreground md:block">
            <Link href="/" className="text-muted-foreground no-underline hover:text-foreground">
              Audits
            </Link>{' '}
            / {host}
          </nav>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="m-0 min-w-0 truncate text-[19px] font-semibold leading-[26px] tracking-[-0.01em]">{host}</h1>
            {CARE_LABEL[care] === undefined ? null : (
              <span title={care} className="hidden h-[26px] shrink-0 items-center whitespace-nowrap rounded-full bg-surface-2 px-3 text-[12px] font-medium md:inline-flex">
                {CARE_LABEL[care]}
              </span>
            )}
            <span className="hidden shrink-0 md:contents">{statePillEl}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 md:gap-2.5">
          {liveShown ? <Liveness tone={live.tone} text={live.text} className="max-md:hidden" /> : null}
          {/* A run stopped before it started never ran: no "Ran for 0m 00s". */}
          {(terminal || queued) && startedMs === null ? null : (
            <div className="hidden text-right text-[11.5px] leading-[15px] text-muted-foreground sm:block">
              {terminal ? 'Ran for' : 'Elapsed'}
              <b className="block text-[15px] font-semibold text-foreground tabular-nums" suppressHydrationWarning>
                {hms(elapsedS)}
              </b>
            </div>
          )}
          {/* One gold next step: the conversation's last line carries it; other views get it here. */}
          {terminal ? (
            <>
              <span className="max-lg:hidden">
                <RunAgain requestId={run.requestId} />
              </span>
              {tab === 'conversation' && filter === null ? null : (
                <Link href={resultsHref} className={buttonClass('primary', 'h-10 max-md:h-11')}>
                  See results
                  <Icon name="arrow" size={14} />
                </Link>
              )}
            </>
          ) : (
            <PendingButton
              variant="secondary"
              className="max-md:h-11 max-md:w-11 max-md:px-0 max-md:[&_[aria-live]]:sr-only"
              title={queued ? 'Waiting to start: nothing to pause yet' : run.paused ? 'Resume' : 'Pause'}
              icon={run.paused ? 'replay' : 'pause'}
              pendingLabel={run.paused ? 'Resuming…' : 'Pausing…'}
              disabled={stopping || run.state === 'queued'}
              onAction={() => control(run.paused ? 'resume' : 'pause')}
            >
              {/* Phones: icon only (44 px), so liveness, Pause, Team and More share one row. */}
              <span className="max-md:sr-only">{run.paused ? 'Resume' : 'Pause'}</span>
            </PendingButton>
          )}
          {/* Phones stop from the top bar's red icon (spec §9), which targets this audit on its own page. */}
          <KillButton run={terminal ? null : { id: run.id, assetName: host, startedAt: run.startedAt }} className="h-10 px-4 max-md:hidden" />
          <button
            type="button"
            aria-label="Blackwing's team"
            title="Blackwing's team"
            onClick={() => {
              setTeam(true);
            }}
            className="inline-flex size-11 items-center justify-center rounded-[10px] border border-input-strong bg-card md:hidden"
          >
            <Icon name="team" size={16} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={moreRef}
              aria-label="More actions"
              className="flex size-10 max-md:size-11 items-center justify-center rounded-[10px] border border-input-strong bg-card text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              <Icon name="more" size={18} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[260px] border border-border bg-card text-foreground shadow-float">
              <DropdownMenuItem
                className="gap-2.5 lg:hidden"
                onSelect={() => {
                  setPanel(true);
                }}
              >
                <Icon name="clock" size={15} />
                Limits and findings
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5"
                onSelect={() => {
                  setDetails(true);
                }}
              >
                <Icon name="file" size={15} />
                Run details
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5"
                onSelect={() => {
                  download(`run-${run.id}-transcript.json`, JSON.stringify({ run: { ...run, events: undefined }, events }, null, 2));
                }}
              >
                <Icon name="download" size={15} />
                Download transcript (JSON)
              </DropdownMenuItem>
              {terminal ? (
                <DropdownMenuItem
                  className="gap-2.5"
                  onSelect={() => {
                    void runAgainAction(run.requestId).then((r) => {
                      if (r.ok) {
                        window.dispatchEvent(new Event('bw:refresh'));
                        router.push(`/audits/${encodeURIComponent(r.data.id)}`);
                      }
                    });
                  }}
                >
                  <Icon name="repeat" size={15} />
                  Run this audit again
                </DropdownMenuItem>
              ) : null}
              {terminal && untriedCount > 0 ? (
                <DropdownMenuItem
                  className="gap-2.5"
                  onSelect={() => {
                    // Continue where it left off: the fuller picker (limits, carried-forward findings) lives on the
                    // results page; this jumps there so the choice is deliberate.
                    router.push(`${resultsHref}#continue`);
                  }}
                >
                  <Icon name="repeat" size={15} />
                  Continue where it left off
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2.5"
                onSelect={() => {
                  void navigator.clipboard.writeText(run.id).then(
                    () => {
                      setCopied(true);
                      window.setTimeout(() => {
                        setCopied(false);
                      }, 1600);
                    },
                    () => {
                      setDetails(true);
                    },
                  );
                }}
              >
                <Icon name="copy" size={15} />
                Copy run id
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span aria-live="polite" className={copied ? 'whitespace-nowrap text-[12px] font-medium text-ok' : 'sr-only'}>
            {copied ? 'Run id copied' : ''}
          </span>
        </div>
        {/* min-w-0: the pill truncates so liveness is never clipped at 390 px. */}
        <div className="flex min-w-0 basis-full items-center gap-2.5 md:hidden">
          {statePillEl}
          {liveShown ? <Liveness tone={live.tone} text={live.text} short={live.short} /> : null}
        </div>
        {controlError === null ? null : (
          <p role="alert" className="m-0 w-full text-[12.5px] text-bad">
            {controlError}
          </p>
        )}
      </header>

      <StageSpine stages={spine} approvedAt={approvedAt === null || !mounted ? null : shortTime(approvedAt)} resultsHref={terminal ? resultsHref : null} />

      {authorisation === null ? null : (
        <AuthorisedUnder
          auth={authorisation}
          variant="strip"
          action={
            <button
              type="button"
              onClick={() => {
                setDetails(true);
              }}
              className="shrink-0 text-[12px] font-medium text-gold-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              Details
            </button>
          }
        />
      )}

      {queued && !stopping ? (
        <p role="status" className="m-0 flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-[12.5px] text-muted-foreground md:px-6">
          <Icon name="clock" size={14} className="shrink-0 text-foreground" />
          <span>
            <b className="font-semibold text-foreground">Waiting to start.</b>{' '}
            {run.queue === null ? 'Nothing has been sent to the site yet.' : queueCopy(run.queue)}
          </span>
        </p>
      ) : null}

      {run.paused && !terminal && !stopping ? (
        <p role="status" className="m-0 flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-[12.5px] text-muted-foreground md:px-6">
          <Icon name="pause" size={14} className="shrink-0 text-foreground" />
          <span>
            <b className="font-semibold text-foreground">Paused.</b> No new request goes out until you resume. An agent may
            finish the thought it is on, and the time limit keeps running.
            {pending.length > 0 ? (
              <b className="font-semibold text-gold-ink">
                {' '}
                {pending.length === 1 ? 'The open decision keeps its clock' : `The ${pending.length} open decisions keep their clocks`}: no
                answer in time is a denial.
              </b>
            ) : null}
          </span>
        </p>
      ) : null}

      {/* A pending decision pins a gold banner under the top bar. */}
      {firstOpen === undefined || terminal ? null : <DecisionBanner g={firstOpen} more={pending.length - 1} />}

      {/* One row that fills the height: the side panel scrolls on its own instead of stretching the page. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_316px]">
        <div className="flex min-h-0 min-w-0 flex-col px-4 pt-3 md:px-[22px]">
          <div className="hidden md:block">
            <TeamMap
              {...mapProps}
              collapsed={mapCollapsed}
              onToggle={() => {
                const next = !mapCollapsed;
                setMapCollapsed(next);
                try {
                  window.localStorage.setItem(MAP_KEY, next ? '1' : '0');
                } catch {
                  // per-viewer convenience only
                }
              }}
            />
          </div>
          <div className="mb-1 mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div role="tablist" aria-label="Live audit views" onKeyDown={onTabKey} className="flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-[10px] bg-surface-2 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  tabIndex={tab === t.id ? 0 : -1}
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  onClick={(e) => {
                    setTab(t.id);
                    e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                  }}
                  className={`h-8 max-md:h-10 whitespace-nowrap rounded-lg border px-3.5 max-md:px-2 max-md:text-[12.5px] text-[13px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${tab === t.id ? 'border-border bg-surface text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setPanel(true);
              }}
              className="hidden h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium md:inline-flex lg:hidden"
            >
              Limits and findings
            </button>
            {filter === null ? null : (
              <button
                type="button"
                onClick={() => {
                  setFilter(null);
                }}
                className="inline-flex h-11 items-center gap-1.5 rounded-full bg-gold-soft px-4 text-[13px] font-medium text-gold-ink md:hidden"
              >
                Only {agentName(filter)}
                <Icon name="x" size={12} />
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <span
                className="hidden items-center gap-1.5 text-[11px] text-muted-foreground xl:flex"
                title="Blackwing AI's messages are its own words and stay unverified until the validator proves them. Counts and requests come from the run's own events."
              >
                <VoiceTag voice="claude" />
                Unverified until proven
              </span>
              <button
                type="button"
                onClick={() => {
                  setFocusTab(true);
                }}
                aria-label={`Open ${tabLabel} full screen`}
                title="Full screen"
                className="hidden h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus md:inline-flex"
              >
                <ExpandIcon size={13} />
                Full screen
              </button>
            </div>
          </div>
          <div
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className={`relative flex min-h-0 flex-1 flex-col ${tab === 'conversation' ? '' : 'overflow-y-auto pb-6 pt-3 [scrollbar-color:var(--border2)_transparent] [scrollbar-width:thin]'}`}
          >
            {focusTab ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <p className="m-0 text-[13px]">{tabLabel} is open full screen.</p>
                <button type="button" className={buttonClass('secondary', 'h-9 px-3.5 text-[13px]')} onClick={() => { setFocusTab(false); }}>
                  Exit full screen
                </button>
              </div>
            ) : (
              tabContent
            )}
          </div>
        </div>
        <aside aria-label="Limits and findings" className="relative hidden min-h-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface px-[18px] py-3.5 [scrollbar-color:var(--border2)_transparent] [scrollbar-width:thin] lg:flex">
          {sidePanel}
        </aside>
      </div>

      <Modal
        open={focusTab}
        onClose={() => {
          setFocusTab(false);
        }}
        label={`${tabLabel}, full screen`}
        className="h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-[1200px]"
      >
        <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="m-0 text-[14px] font-semibold">{tabLabel}</h2>
          <button
            type="button"
            onClick={() => {
              setFocusTab(false);
            }}
            aria-label="Exit full screen"
            className="inline-flex size-9 items-center justify-center rounded-[10px] border border-border text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className={`flex min-h-0 flex-1 flex-col px-4 ${tab === 'conversation' ? '' : 'overflow-y-auto py-3'}`}>
          {focusTab ? tabContent : null}
        </div>
        </div>
      </Modal>
      <RunDetailsSheet
        run={run}
        model={model}
        autoReleased={teamMap.autoReleased}
        open={details}
        onOpenChange={setDetails}
        returnFocus={() => moreRef.current}
      />
      <ExchangeSheet
        returnFocus={() => callOrigin.current}
        exchange={exchange}
        state={openCall?.state ?? 'closed'}
        onOpenChange={(o) => {
          if (!o) setOpenCall(null);
        }}
        onRetry={() => {
          if (openCall !== null) openExchange(openCall.id);
        }}
      />
      <Sheet open={team} onOpenChange={setTeam}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto border-border bg-card p-4 pt-5 text-foreground">
          <SheetTitle className="sr-only">Blackwing&apos;s team</SheetTitle>
          <TeamMap {...mapProps} layout="column" />
        </SheetContent>
      </Sheet>
      <Sheet open={panel} onOpenChange={setPanel}>
        <SheetContent side="bottom" className="flex max-h-[85dvh] flex-col gap-4 overflow-y-auto border-border bg-card p-5 pt-6 text-foreground">
          <SheetTitle className="sr-only">Limits and findings</SheetTitle>
          {sidePanel}
        </SheetContent>
      </Sheet>
    </section>
  );
}
