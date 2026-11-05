/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// The conversation (experience spec §5.2 item 5): the agents' real exchange, read from the run's events. The planner
// delegates (Planner → specialist, its instruction in a bubble), the specialist's turns, calls and Gate 2 requests nest
// under it, and its report closes the thread. Three voices are never blurred: Claude (slate tag, its own words, not
// verified), Blackwing (crow tile, template lines from host-lines.ts) and the validator (green, replay, no model).
// It follows the newest item while the reader is at the bottom; otherwise "Jump to latest" shows.
import Link from 'next/link';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { buttonClass, Icon, SeverityChip, VoiceTag } from './design';
import { Gate2Card } from './gate2-view';
import { Markdown } from './markdown';
import {
  type CallRow,
  type ConversationItem,
  type HostItem,
  type ThreadChild,
  type ThreadItem,
  type TurnItem,
  type ValidatorItem,
  VALIDATOR_REPLAYS,
  ruleWords,
} from './run-model';
import { agentInitials, agentName } from '../../lib/agents';

import type { Gate2 } from '../../lib/schemas';

const CALLS_SHOWN = 3;
/** Very long runs show the newest items first; "Show earlier" reveals the rest. */
const WINDOW = 400;
/** Within this many pixels of the bottom counts as "at the bottom" (auto-follow on). */
const FOLLOW_SLACK_PX = 96;

const timeFmt = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

function Time({ at }: { readonly at: string }) {
  // The server renders in its own time zone; the browser corrects it without a hydration error.
  return (
    <time dateTime={at} suppressHydrationWarning className="ml-auto shrink-0 whitespace-nowrap pl-3 font-mono text-[10.5px] text-muted-foreground">
      {timeFmt(at)}
    </time>
  );
}

/** Text clamped to `lines`, with "Show all" only when it overflows. */
function Clamp({ lines, children, className = '' }: { readonly lines: number; readonly children: ReactNode; readonly className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || open) return;
    const check = (): void => {
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [open, children]);
  return (
    <div className={className}>
      <div
        ref={ref}
        className="overflow-hidden"
        style={open ? undefined : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines }}
      >
        {children}
      </div>
      {overflows || open ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="mt-1 text-[12px] font-medium text-gold-ink hover:underline"
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}

function Avatar({ agent }: { readonly agent: string }) {
  const tone =
    agent === 'orchestrator' ? 'bg-text text-bg' : agent === 'validator' ? 'bg-ok-soft text-ok' : 'bg-slate-soft text-slate';
  return (
    <span aria-hidden="true" className={`flex size-6 shrink-0 items-center justify-center rounded-[7px] text-[10px] font-bold ${tone}`}>
      {agent === 'validator' ? <Icon name="check" size={12} /> : agentInitials(agent)}
    </span>
  );
}

function CrowTile() {
  return (
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-gold-soft shadow-[inset_0_0_0_1px_var(--gold-line)]">
      <img src="/brand/crow-shield.png" alt="" width={11} height={11} className="object-contain" />
    </span>
  );
}

function statusTone(status: number): string {
  if (status === 0 || status >= 500) return 'bg-bad-soft text-bad';
  if (status >= 300) return 'bg-med-soft text-med';
  return 'bg-ok-soft text-ok';
}

function CallList({ calls, onOpen }: { readonly calls: readonly CallRow[]; readonly onOpen: (exchangeId: string) => void }) {
  const [all, setAll] = useState(false);
  if (calls.length === 0) return null;
  const shown = all ? calls : calls.slice(0, CALLS_SHOWN);
  return (
    <div className="mt-1.5 flex flex-col gap-1 pl-8">
      {shown.map((c) =>
        c.blocked ? (
          <div
            key={c.seq}
            className="flex min-h-[30px] items-center gap-2.5 rounded-[8px] border border-dashed border-warn bg-warn-soft px-2.5 py-1 text-[11.5px] text-warn"
          >
            <Icon name="lock" size={12} />
            <span className="min-w-0 flex-1">
              <span className="font-medium">Blocked by scope: not sent</span> ({ruleWords(c.rule ?? '')})
              <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                {c.method} {c.path}
              </span>
            </span>
          </div>
        ) : (
          <button
            key={c.seq}
            type="button"
            disabled={c.exchangeId === null}
            onClick={() => {
              if (c.exchangeId !== null) onOpen(c.exchangeId);
            }}
            title="Open the request and response"
            className="flex h-[30px] w-full items-center gap-2.5 rounded-[8px] border border-border bg-surface px-2.5 text-left font-mono text-[11.5px] hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus disabled:cursor-default"
          >
            <span className="font-medium text-slate">{c.method}</span>
            <span className="min-w-0 flex-1 truncate">
              {c.path}
              {c.asRole === null ? null : <span className="text-muted-foreground"> · as {c.asRole}</span>}
            </span>
            <span className={`rounded-[5px] px-1.5 py-px text-[10.5px] font-medium ${statusTone(c.status ?? 0)}`}>{c.status}</span>
            <span className="w-12 text-right text-[10.5px] text-muted-foreground">{c.ms} ms</span>
          </button>
        ),
      )}
      {calls.length > CALLS_SHOWN ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
          className="self-start py-0.5 text-[12px] font-medium text-gold-ink hover:underline"
        >
          {all ? 'Show fewer' : `Show ${calls.length - CALLS_SHOWN} more`}
        </button>
      ) : null}
    </div>
  );
}

function Turn({ turn, onOpenCall }: { readonly turn: TurnItem; readonly onOpenCall: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
        <Avatar agent={turn.agent} />
        <span className="font-semibold">{agentName(turn.agent)}</span>
        {agentName(turn.agent) === turn.agent ? null : (
          <span className="hidden font-mono text-[10.5px] text-muted-foreground sm:inline">{turn.agent}</span>
        )}
        {turn.reply ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Icon name="reply" size={12} />
            Planner
          </span>
        ) : null}
        <VoiceTag voice="claude" />
        <Time at={turn.at} />
      </div>
      {turn.text === null ? null : (
        <Clamp lines={turn.reply ? 6 : 10} className="ml-8 mt-1">
          {turn.isError ? <p className="m-0 mb-1 text-[12.5px] font-medium text-bad">The agent reported an error.</p> : null}
          <Markdown text={turn.text} className="text-[14px] leading-[22px]" />
        </Clamp>
      )}
      {turn.tools.length === 0 ? null : (
        <div className="ml-8 mt-1.5 flex flex-wrap gap-1.5">
          {turn.tools.map((t, i) => (
            <span key={`${t}-${i}`} className="inline-flex h-[22px] max-w-full items-center gap-1.5 truncate rounded-md bg-surface-2 px-2 text-[11.5px] text-muted-foreground">
              <Icon name="term" size={11} />
              {t}
            </span>
          ))}
        </div>
      )}
      <CallList calls={turn.calls} onOpen={onOpenCall} />
    </div>
  );
}

function ValidatorTurn({ v, onOpenCall }: { readonly v: ValidatorItem; readonly onOpenCall: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
        <Avatar agent="validator" />
        <span className="font-semibold">Validator</span>
        <VoiceTag voice="validator" />
        <Time at={v.at} />
      </div>
      <div className="ml-8 mt-1 flex flex-col gap-1.5">
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]">
          {v.severity === '' ? null : <SeverityChip severity={v.severity} />}
          <span className="font-medium">{v.title}</span>
        </p>
        {v.verdict === 'proving' ? (
          <p className="m-0 flex items-center gap-2 rounded-[10px] bg-slate-soft px-3 py-[7px] text-[13px] text-slate">
            <span aria-hidden="true" className="size-2.5 rounded-full border-2 border-current border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]" />
            <span>
              Proving: replay {Math.min(v.replays, VALIDATOR_REPLAYS)} of {VALIDATOR_REPLAYS}
              {v.control === null ? '' : ` · Negative control: ${v.control.matched ? 'it matched too' : 'behaved as expected'} (${v.control.status})`}
            </span>
          </p>
        ) : v.verdict === 'proven' ? (
          <p className="m-0 flex items-center gap-2 rounded-[10px] bg-ok-soft px-3 py-[7px] text-[13px] text-ok">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border-2 border-current" />
            <span>
              <b className="font-semibold">Proven.</b> Replayed {v.matched} of {VALIDATOR_REPLAYS} times; the control behaved as expected.{' '}
              {v.autoReleased ? 'Released automatically.' : 'Waits for your release.'}
            </span>
          </p>
        ) : (
          <p className="m-0 flex items-center gap-2 rounded-[10px] border border-dashed border-border-strong bg-surface-2 px-3 py-[7px] text-[13px] text-muted-foreground">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border-2 border-dashed border-current" />
            <span>
              <b className="font-semibold text-foreground">Not proven:</b> {v.reason ?? 'the replay did not hold'}. Kept back from the report.
            </span>
          </p>
        )}
      </div>
      <CallList calls={v.calls} onOpen={onOpenCall} />
    </div>
  );
}

function HostLine({ item, resultsHref }: { readonly item: HostItem; readonly resultsHref: string | null }) {
  const finished = item.kind === 'run.completed';
  return (
    <div className={`flex items-start gap-2.5 text-[12.5px] leading-[19px] ${finished ? 'rounded-[12px] border border-gold-line bg-gold-soft p-3' : ''}`}>
      <CrowTile />
      <span className={finished ? 'flex flex-1 flex-wrap items-center gap-3 font-medium text-foreground' : 'text-muted-foreground'}>
        {item.text}
        {finished && resultsHref !== null ? (
          <Link href={resultsHref} className={buttonClass('primary', 'h-9 px-4')}>
            See results
            <Icon name="arrow" size={14} />
          </Link>
        ) : null}
      </span>
      <Time at={item.at} />
    </div>
  );
}

interface ChildProps {
  readonly gate2: readonly Gate2[];
  readonly viewerName: string | null;
  readonly resultsHref: string | null;
  readonly onOpenCall: (exchangeId: string) => void;
}

function Child({ item, ...p }: ChildProps & { readonly item: ThreadChild }) {
  switch (item.type) {
    case 'turn':
      return <Turn turn={item} onOpenCall={p.onOpenCall} />;
    case 'validator':
      return <ValidatorTurn v={item} onOpenCall={p.onOpenCall} />;
    case 'host':
      return <HostLine item={item} resultsHref={p.resultsHref} />;
    case 'gate2': {
      // The card (C's Gate2Card) collapses to its receipt once decided; without the row, the Blackwing line stands in.
      const row = p.gate2.find((g) => g.id === item.gate2Id);
      if (row !== undefined)
        return (
          <div data-gate2-pending={row.status === 'pending' ? row.id : undefined}>
            <Gate2Card gate2={row} body={item.body} asRole={item.asRole} viewerName={p.viewerName} />
          </div>
        );
      return item.decided === null ? null : (
        <HostLine item={{ type: 'host', key: item.key, seq: item.seq, at: item.at, kind: 'gate2.decided', text: item.decided }} resultsHref={null} />
      );
    }
  }
}

function Thread({ thread, ...p }: ChildProps & { readonly thread: ThreadItem }) {
  return (
    <div className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
        <Avatar agent={thread.from} />
        <span className="font-semibold">{agentName(thread.from)}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Icon name="arrow" size={12} />
          <span className="truncate">{agentName(thread.to)}</span>
        </span>
        <VoiceTag voice="claude" />
        <Time at={thread.at} />
      </div>
      <Clamp lines={3} className="ml-8 mt-1 rounded-[4px_12px_12px_12px] border border-border bg-surface-2 px-3 py-2 text-[13.5px] leading-[21px]">
        <span className="whitespace-pre-wrap">{thread.task === '' ? 'No instruction was recorded.' : thread.task}</span>
      </Clamp>
      {thread.children.length === 0 ? null : (
        <div className="ml-3 mt-2.5 flex flex-col gap-3 border-l-2 border-border pl-[18px]">
          {thread.children.map((c) => (
            <Child key={c.key} item={c} {...p} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Conversation({
  items,
  gate2,
  viewerName,
  resultsHref,
  onOpenCall,
  emptyText,
}: {
  readonly items: readonly ConversationItem[];
  readonly gate2: readonly Gate2[];
  /** The signed-in person's name, so a receipt can say "by you". */
  readonly viewerName: string | null;
  readonly resultsHref: string | null;
  readonly onOpenCall: (exchangeId: string) => void;
  readonly emptyText: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(-WINDOW);
  // A signature of the content: new items, and growth inside the newest thread, both count as "something new".
  const last = items.at(-1);
  const signature = `${items.length}:${last?.key ?? ''}:${last?.type === 'thread' ? last.children.length : 0}`;

  useEffect(() => {
    const el = scroller.current;
    if (el !== null && follow) el.scrollTop = el.scrollHeight;
  }, [signature, follow]);

  // A pending decision can sit in an earlier thread: while it is out of view a bar points to it.
  const pendingKey = gate2
    .filter((g) => g.status === 'pending')
    .map((g) => g.id)
    .join(',');
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    const root = scroller.current;
    if (root === null || pendingKey === '') {
      setHidden([]);
      return;
    }
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set((e.target as HTMLElement).dataset.gate2Pending ?? '', e.isIntersecting);
        setHidden([...seen].filter(([, visible]) => !visible).map(([id]) => id));
      },
      { root, threshold: 0.25 },
    );
    root.querySelectorAll<HTMLElement>('[data-gate2-pending]').forEach((el) => {
      observer.observe(el);
    });
    return () => {
      observer.disconnect();
    };
  }, [pendingKey, signature]);
  const goTo = (id: string): void => {
    const target = scroller.current?.querySelector<HTMLElement>(`[data-gate2-pending="${CSS.escape(id)}"]`);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  };

  const p: ChildProps = { gate2, viewerName, resultsHref, onOpenCall };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX);
        }}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3.5 pb-6 pt-3">
          {items.length > shown.length ? (
            <button
              type="button"
              onClick={() => {
                setAll(true);
              }}
              className={buttonClass('ghost', 'h-8 self-center text-[12.5px]')}
            >
              Show earlier ({items.length - shown.length})
            </button>
          ) : null}
          {shown.length === 0 ? (
            <div className="flex items-center gap-2.5 py-6 text-[13px] text-muted-foreground">
              <CrowTile />
              {emptyText}
            </div>
          ) : null}
          {shown.map((item) =>
            item.type === 'thread' ? <Thread key={item.key} thread={item} {...p} /> : <Child key={item.key} item={item} {...p} />,
          )}
        </div>
      </div>
      {hidden[0] === undefined ? null : (
        <button
          type="button"
          onClick={() => {
            if (hidden[0] !== undefined) goTo(hidden[0]);
          }}
          className="absolute bottom-16 left-1/2 inline-flex h-10 -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-gold-ink bg-gold-soft px-4 text-[13px] font-semibold text-gold-ink shadow-float focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          <Icon name="hand" size={15} />
          {hidden.length === 1 ? 'A decision waits for you' : `${hidden.length} decisions wait for you`} · Show
        </button>
      )}
      {follow || items.length === 0 ? null : (
        <button
          type="button"
          onClick={() => {
            const el = scroller.current;
            if (el === null) return;
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
            setFollow(true);
          }}
          className="absolute bottom-4 left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-[12.5px] font-medium text-foreground shadow-float hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          <Icon name="chevron" size={14} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
