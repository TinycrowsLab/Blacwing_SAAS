/* Presentational values (poll intervals, widths) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Watch Claude work (experience spec §5): the live audit. The first render comes from the server; the client polls the
// run route (afterSeq) every 1.5 s while the tab is visible, backs off on failure (1.5, 3, 6, 10 s) and keeps the data
// it has. Everything shown is derived from the run DTO and its events in run-model.ts.
// shortcut: polling, not SSE; upgrade when the API gains an event stream.
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

import { Conversation } from './conversation';
import { buttonClass, Icon, VoiceTag } from './design';
import { clockLabel, PendingButton } from './design-client';
import { FlightDeck, FoundPanel, LimitsPanel, PlanPanel, RequestsTab, TestPlanTab } from './flight-deck';
import { KillButton } from './kill-dialog';
import { CARE_LABEL, ExchangeSheet, RunDetailsSheet } from './run-details-sheet';
import {
  type Exchange,
  TERMINAL_STATES,
  agentLanes,
  candidates,
  caseList,
  conversationItems,
  describe,
  exchangeListSchema,
  filterConversation,
  hms,
  isOpenGate2,
  liveness,
  mergeEvents,
  stages,
  teamNodes,
} from './run-model';
import { StageSpine } from './stage-spine';
import { TeamMap } from './team-map';
import { useNow } from './use-now';
import { agentName } from '../../lib/agents';
import { decisionTitle } from '../../lib/plan-text';
import { type Run, type RunEvent, runSchema } from '../../lib/schemas';


const BACKOFF_MS = [1500, 3000, 6000, 10_000] as const;
/** The Requests tab refreshes this often while it is open and the run is live. */
const EXCHANGES_REFRESH_MS = 5000;
/** The API returns at most this many exchanges per page (store EXCHANGE_PAGE). */
const EXCHANGE_PAGE = 200;

type Tab = 'conversation' | 'plan' | 'requests' | 'deck';
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

const hhmm = (iso: string): string => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

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

function Liveness({ tone, text }: { readonly tone: 'live' | 'quiet' | 'reconnecting'; readonly text: string }) {
  const dot = tone === 'live' ? 'bg-ok motion-safe:animate-[bwpulse_1.6s_ease-in-out_infinite]' : tone === 'quiet' ? 'bg-faint' : 'bg-warn';
  return (
    <span role="status" className={`flex items-center gap-1.5 whitespace-nowrap text-[11.5px] ${tone === 'reconnecting' ? 'text-warn' : 'text-muted-foreground'}`}>
      <span aria-hidden="true" className={`size-[7px] rounded-full ${dot}`} />
      {text}
    </span>
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
  const [run, setRun] = useState<Run>(initial);
  const [events, setEvents] = useState<RunEvent[]>(initial.events);
  const [tab, setTab] = useState<Tab>('conversation');
  const [filter, setFilter] = useState<string | null>(null);
  const [failedSince, setFailedSince] = useState<number | null>(null);
  const [lastOk, setLastOk] = useState(() => Date.now());
  const [controlError, setControlError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [team, setTeam] = useState(false);
  const [panel, setPanel] = useState(false);
  const [copied, setCopied] = useState(false);
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
      failures.current = 0;
      setFailedSince(null);
      setLastOk(Date.now());
      setRun(next);
      if (next.events.length > 0) setEvents((prev) => mergeEvents(prev, next.events));
      return true;
    } catch {
      failures.current += 1;
      setFailedSince((s) => s ?? Date.now());
      return false;
    }
  }, [initial.id]);

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
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      void poll().then(() => {
        if (!stopped) schedule();
      });
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [terminal, poll]);

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

  const openExchange = useCallback(
    (id: string): void => {
      if (exchanges.items.some((x) => x.id === id)) {
        setOpenCall({ id, state: 'ready' });
        return;
      }
      setOpenCall({ id, state: 'loading' });
      void exchanges.load().then((fresh) => {
        setOpenCall((cur) =>
          cur?.id !== id ? cur : { id, state: fresh === null ? 'error' : fresh.some((x) => x.id === id) ? 'ready' : 'missing' },
        );
      });
    },
    [exchanges],
  );

  async function control(action: 'pause' | 'resume'): Promise<void> {
    setControlError(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { message?: unknown };
        setControlError(typeof problem.message === 'string' ? problem.message : `Couldn't ${action} the audit. Try again.`);
        return;
      }
      await poll();
      window.dispatchEvent(new Event('bw:refresh'));
    } catch {
      setControlError("Couldn't reach Blackwing. Nothing changed. Try again.");
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

  const items = useMemo(() => conversationItems(events, run.gate2), [events, run.gate2]);
  const shownItems = useMemo(() => (filter === null ? items : filterConversation(items, filter)), [items, filter]);
  const spine = useMemo(() => stages(events, { terminal, approvedBy }), [events, terminal, approvedBy]);
  const teamMap = useMemo(() => teamNodes(events, run.gate2, nowMs, terminal), [events, run.gate2, nowMs, terminal]);
  const cases = useMemo(() => caseList(events), [events]);
  const cands = useMemo(() => candidates(events), [events]);
  const pending = run.gate2.filter((g) => isOpenGate2(g, nowMs));
  const waitingAgents = useMemo(() => new Set(pending.map((g) => g.agent)), [pending]);
  const stopping = !terminal && events.some((e) => e.kind === 'kill.requested');
  const model = events.find((e) => e.kind === 'run.started')?.data.model;

  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = run.finishedAt === null ? (mounted ? nowMs : start) : new Date(run.finishedAt).getTime();
  const elapsedS = Math.max(0, (end - start) / 1000);
  const lastEvent = events.at(-1);
  const live = liveness(nowMs, lastEvent === undefined ? start : Date.parse(lastEvent.at), failedSince, lastOk);
  const resultsHref = `/runs/${encodeURIComponent(run.id)}/results`;

  const stateText = terminal
    ? run.state === 'completed'
      ? 'Finished'
      : run.state === 'killed'
        ? 'Stopped'
        : 'Stopped with an error'
    : stopping
      ? 'Stopping…'
      : run.state === 'queued'
        ? 'Queued'
        : run.paused
          ? 'Paused'
          : pending.length > 0
            ? `Testing · ${pending.length} ${pending.length === 1 ? 'decision waits' : 'decisions wait'} for you`
            : 'Testing';
  const statePill =
    pending.length > 0 && !terminal ? 'border-gold-line bg-gold-soft text-gold-ink' : 'border-border bg-surface-2 text-foreground';

  const lanes = useMemo(() => agentLanes(events), [events]);
  const rows = useMemo(() => events.flatMap((e) => describe(e) ?? []), [events]);
  const lastPause = events.findLast((e) => e.kind === 'run.paused');
  const pausedFrom = (agent: string): number | null => {
    const g = pending.find((x) => x.agent === agent);
    if (g !== undefined) return g.createdAt === undefined ? end : new Date(g.createdAt).getTime();
    return run.paused && lastPause !== undefined ? new Date(lastPause.at).getTime() : null;
  };

  const gate1 = `${approvedBy === 'you' ? 'You' : (approver ?? 'Approved')}${approvedAt === null || !mounted ? '' : `, ${hhmm(approvedAt)}`}`;
  const map = (
    <TeamMap
      team={teamMap}
      gate1={gate1}
      gate3={release === 'auto' ? 'Automatic' : 'You, later'}
      filter={filter}
      onFilter={(a) => {
        setFilter(a);
        setTab('conversation');
        setTeam(false);
      }}
    />
  );
  const sidePanel: ReactNode = (
    <>
      <LimitsPanel elapsedS={elapsedS} budget={run.budget} requestsUsed={run.requestsUsed} costUsd={run.costUsd} />
      <PlanPanel cases={cases} waiting={waitingAgents} />
      <FoundPanel items={cands} />
      <p className="m-0 mt-auto border-t border-dashed border-border-strong pt-2.5 text-[11px] leading-4 text-muted-foreground">
        Counts, limits and times come from the runner. Claude&apos;s messages are its own words and stay unverified until the
        validator proves them.
      </p>
    </>
  );
  const exchange = openCall === null ? null : (exchanges.items.find((x) => x.id === openCall.id) ?? null);
  const firstPending = pending[0];

  return (
    <section
      aria-label={`Live audit of ${host}`}
      className="-mx-4 -my-5 flex h-[calc(100dvh-52px)] flex-col sm:-mx-6 md:-mx-8 md:-my-7 md:h-dvh"
    >
      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5 md:px-6">
        <div className="min-w-0 flex-1">
          <nav aria-label="Breadcrumb" className="hidden text-[12px] text-muted-foreground md:block">
            <Link href="/" className="text-muted-foreground no-underline hover:text-foreground">
              Audits
            </Link>{' '}
            / {host}
          </nav>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="m-0 truncate text-[19px] font-semibold leading-[26px] tracking-[-0.01em]">{host}</h1>
            {CARE_LABEL[care] === undefined ? null : (
              <span title={care} className="inline-flex h-[26px] items-center rounded-full bg-surface-2 px-3 text-[12px] font-medium">
                {CARE_LABEL[care]}
              </span>
            )}
            <span className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium ${statePill}`}>
              {terminal ? null : <span aria-hidden="true" className={`size-1.5 rounded-full ${pending.length > 0 ? 'bg-gold' : 'bg-text'}`} />}
              {stateText}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {terminal || !mounted ? null : <Liveness tone={live.tone} text={live.text} />}
          <div className="hidden text-right text-[11.5px] leading-[15px] text-muted-foreground sm:block">
            {terminal ? 'Ran for' : 'Elapsed'}
            <b className="block text-[15px] font-semibold text-foreground tabular-nums" suppressHydrationWarning>
              {hms(elapsedS)}
            </b>
          </div>
          {terminal ? (
            <Link href={resultsHref} className={buttonClass('secondary', 'h-10')}>
              See results
            </Link>
          ) : (
            <PendingButton
              variant="secondary"
              icon={run.paused ? 'replay' : 'pause'}
              pendingLabel={run.paused ? 'Resuming…' : 'Pausing…'}
              disabled={stopping || run.state === 'queued'}
              onAction={() => control(run.paused ? 'resume' : 'pause')}
            >
              {run.paused ? 'Resume' : 'Pause'}
            </PendingButton>
          )}
          <KillButton run={terminal ? null : { id: run.id, assetName: host }} className="h-10 px-4" />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="More actions"
              className="flex size-10 items-center justify-center rounded-[10px] border border-input-strong bg-card text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              <Icon name="more" size={18} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[230px]">
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
          <span aria-live="polite" className="sr-only">
            {copied ? 'Run id copied' : ''}
          </span>
        </div>
        {controlError === null ? null : (
          <p role="alert" className="m-0 w-full text-[12.5px] text-bad">
            {controlError}
          </p>
        )}
      </header>

      <StageSpine stages={spine} approvedAt={approvedAt === null || !mounted ? null : hhmm(approvedAt)} resultsHref={terminal ? resultsHref : null} />

      {/* Phones: a pending decision pins a gold banner under the top bar. */}
      {firstPending === undefined ? null : (
        <Link
          href={`/decisions/gate2/${firstPending.id}`}
          className="flex items-center gap-2.5 border-b border-gold-line bg-gold-soft px-4 py-2.5 text-[13px] text-foreground no-underline md:hidden"
        >
          <Icon name="hand" size={16} className="text-gold-ink" />
          <span className="min-w-0 flex-1 truncate font-medium">{decisionTitle(firstPending.method, firstPending.url)}</span>
          <span className="font-semibold tabular-nums text-gold-ink" suppressHydrationWarning>
            {mounted ? clockLabel(Math.max(0, Math.floor((Date.parse(firstPending.deadlineAt) - nowMs) / 1000))) : ''}
          </span>
          <span className={buttonClass('primary', 'h-9 px-3.5')}>Decide</span>
        </Link>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_316px]">
        <div className="flex min-h-0 min-w-0 flex-col px-4 pt-3 md:px-[22px]">
          <div className="hidden md:block">{map}</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div role="tablist" aria-label="Live audit views" className="hidden max-w-full gap-0.5 rounded-[10px] bg-surface-2 p-0.5 md:flex">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  onClick={() => {
                    setTab(t.id);
                  }}
                  className={`h-8 whitespace-nowrap rounded-lg border px-3.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${tab === t.id ? 'border-border bg-surface text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setTeam(true);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium md:hidden"
            >
              <Icon name="team" size={14} />
              Team
            </button>
            <button
              type="button"
              onClick={() => {
                setPanel(true);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium lg:hidden"
            >
              Limits and findings
            </button>
            {filter === null ? null : (
              <button
                type="button"
                onClick={() => {
                  setFilter(null);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gold-soft px-3 text-[12.5px] font-medium text-gold-ink md:hidden"
              >
                Only {agentName(filter)}
                <Icon name="x" size={12} />
              </button>
            )}
            <span className="ml-auto hidden items-center gap-3 text-[11px] text-muted-foreground xl:flex">
              <span className="flex items-center gap-1.5">
                <VoiceTag voice="claude" />
                own words, not verified
              </span>
              <span className="flex items-center gap-1.5">
                <img src="/brand/crow-shield.png" alt="" width={12} height={12} className="object-contain" />
                Blackwing, from run events
              </span>
            </span>
          </div>
          <div
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className={`flex min-h-0 flex-1 flex-col ${tab === 'conversation' ? '' : 'overflow-y-auto pb-6 pt-3'}`}
          >
            {tab === 'conversation' ? (
              <Conversation
                items={shownItems}
                gate2={run.gate2}
                viewerName={viewerName}
                resultsHref={resultsHref}
                onOpenCall={openExchange}
                emptyText={
                  filter !== null
                    ? `Nothing from the ${agentName(filter)} yet.`
                    : terminal
                      ? 'This run ended before any agent spoke.'
                      : 'Waiting for the first agent…'
                }
              />
            ) : tab === 'plan' ? (
              <TestPlanTab cases={cases} waiting={waitingAgents} />
            ) : tab === 'requests' ? (
              <RequestsTab
                items={exchanges.items}
                state={exchanges.state}
                onOpen={openExchange}
                onRetry={() => {
                  void exchanges.load();
                }}
              />
            ) : (
              <FlightDeck lanes={lanes} rows={rows} nowMs={end} running={!terminal} pausedFrom={pausedFrom} summary={run.summary} />
            )}
          </div>
        </div>
        <aside aria-label="Limits and findings" className="hidden min-h-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface px-[18px] py-3.5 lg:flex">
          {sidePanel}
        </aside>
      </div>

      <RunDetailsSheet run={run} model={typeof model === 'string' ? model : null} open={details} onOpenChange={setDetails} />
      <ExchangeSheet
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
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto border-border bg-card p-4 text-foreground">
          <SheetTitle className="sr-only">Claude&apos;s team</SheetTitle>
          {map}
        </SheetContent>
      </Sheet>
      <Sheet open={panel} onOpenChange={setPanel}>
        <SheetContent side="right" className="flex w-full max-w-[360px] flex-col gap-4 overflow-y-auto border-border bg-card p-5 pt-12 text-foreground">
          <SheetTitle className="sr-only">Limits and findings</SheetTitle>
          {sidePanel}
        </SheetContent>
      </Sheet>
    </section>
  );
}
