/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// The conversation (experience spec §5.2 item 5): the agents' real exchange, read from the run's events. The planner
// delegates (Planner → specialist, its instruction in a bubble), the specialist's turns, calls and Gate 2 requests nest
// under it, and its report closes the thread. Three voices are never blurred: Claude (slate tag, its own words, not
// verified), Blackwing (crow tile, template lines from host-lines.ts) and the validator (green, replay, no model).
// It follows the newest item while the reader is at the bottom; otherwise "Jump to latest" shows. A new decision that
// arrives while following holds the view at its card (the clock and buttons stay on screen) until it is answered or
// the reader scrolls away.
import Link from 'next/link';
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { buttonClass, Icon, SeverityChip, VoiceTag } from './design';
import { statusTone } from './flight-deck';
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
/** A held decision card sits this far below the top edge. */
const HOLD_GAP_PX = 12;
/** The card's clock and buttons sit in its first this-many pixels: that part must be on screen to count as seen. */
const CARD_ACTIONS_PX = 200;
/** A click this soon after "Show n more" lands on a row that slid under the pointer: ignore it. */
const TOGGLE_GUARD_MS = 450;

const noSubscribe = (): (() => void) => () => undefined;
/** False during the server render and hydration, true after: times are formatted in the viewer's own clock. */
export function useMounted(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** The one clock format of the run page: "8:47 am" in the viewer's locale and time zone. */
export const shortTime = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

function Time({ at }: { readonly at: string }) {
  const mounted = useMounted();
  return (
    <time dateTime={at} className="ml-auto shrink-0 whitespace-nowrap pl-3 text-[11px] tabular-nums text-muted-foreground">
      {mounted ? shortTime(at) : ''}
    </time>
  );
}

const reduceMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Text clamped to `lines` of `lineHeight` px, fading out, with "Show all" only when it overflows. */
function Clamp({
  lines,
  lineHeight,
  children,
  className = '',
}: {
  readonly lines: number;
  readonly lineHeight: number;
  readonly children: ReactNode;
  readonly className?: string;
}) {
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
    <div className={`min-w-0 ${className}`}>
      {/* A max-height, not line-clamp: model text has lists and tables, which line-clamp does not cut. */}
      <div
        ref={ref}
        className={open ? 'overflow-x-auto' : 'overflow-hidden'}
        style={
          open
            ? undefined
            : {
                maxHeight: lines * lineHeight,
                ...(overflows ? { maskImage: 'linear-gradient(to bottom, #000 65%, transparent)' } : {}),
              }
        }
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

function CallList({ calls, onOpen }: { readonly calls: readonly CallRow[]; readonly onOpen: (exchangeId: string) => void }) {
  const [all, setAll] = useState(false);
  const toggledAt = useRef(0);
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
              if (c.exchangeId !== null && Date.now() - toggledAt.current > TOGGLE_GUARD_MS) onOpen(c.exchangeId);
            }}
            title="Open the request and response"
            className="flex h-[30px] w-full max-md:h-11 items-center gap-2.5 rounded-[8px] border border-border bg-surface px-2.5 text-left font-mono text-[11.5px] hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus disabled:cursor-default"
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
            toggledAt.current = Date.now();
            setAll(!all);
          }}
          className="self-start py-0.5 text-[12px] font-medium text-gold-ink hover:underline max-md:min-h-11"
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
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
        <Avatar agent={turn.agent} />
        <span className="font-semibold">{agentName(turn.agent)}</span>
        {agentName(turn.agent) === turn.agent ? null : (
          <span className="hidden font-mono text-[10.5px] text-muted-foreground sm:inline">{turn.agent}</span>
        )}
        {turn.reply ? (
          <span className="flex items-center gap-1 whitespace-nowrap rounded-full bg-surface-2 px-2 py-px text-[11px] font-medium text-muted-foreground">
            <Icon name="reply" size={11} />
            Reply to Planner
          </span>
        ) : null}
        <VoiceTag voice="claude" />
        <Time at={turn.at} />
      </div>
      {turn.text === null ? null : (
        <Clamp lines={6} lineHeight={22} className="ml-8 mt-1">
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

function HostLine({
  item,
  resultsHref,
  onOpenPlan = null,
}: {
  readonly item: HostItem;
  readonly resultsHref: string | null;
  readonly onOpenPlan?: (() => void) | null;
}) {
  const finished = item.kind === 'run.completed';
  return (
    <div className={`flex items-start gap-2.5 text-[12.5px] leading-[19px] ${finished ? 'rounded-[12px] border border-gold-line bg-gold-soft p-3' : ''}`}>
      <CrowTile />
      <span className={finished ? 'flex flex-1 flex-wrap items-center gap-3 font-medium text-foreground' : 'text-muted-foreground'}>
        {item.text}
        {item.kind === 'plan.cases' && onOpenPlan !== null ? (
          <>
            {' '}
            <button type="button" onClick={onOpenPlan} className="font-medium text-gold-ink hover:underline max-md:min-h-11">
              Open the test plan
            </button>
          </>
        ) : null}
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
  readonly onOpenPlan: () => void;
}

function Child({ item, ...p }: ChildProps & { readonly item: ThreadChild }) {
  switch (item.type) {
    case 'turn':
      return <Turn turn={item} onOpenCall={p.onOpenCall} />;
    case 'validator':
      return <ValidatorTurn v={item} onOpenCall={p.onOpenCall} />;
    case 'host':
      return <HostLine item={item} resultsHref={p.resultsHref} onOpenPlan={p.onOpenPlan} />;
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
      <Clamp lines={3} lineHeight={21} className="ml-8 mt-1 rounded-[4px_12px_12px_12px] border border-border bg-surface-2 px-3 py-2 text-[13.5px] leading-[21px]">
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

export const Conversation = memo(function Conversation({
  items,
  gate2,
  viewerName,
  resultsHref,
  onOpenCall,
  onOpenPlan,
  emptyText,
  showDecision,
}: {
  readonly items: readonly ConversationItem[];
  readonly gate2: readonly Gate2[];
  /** The signed-in person's name, so a receipt can say "by you". */
  readonly viewerName: string | null;
  readonly resultsHref: string | null;
  readonly onOpenCall: (exchangeId: string) => void;
  /** "Open the test plan" under the plan line: the tab on desktop, the panel on phones. */
  readonly onOpenPlan: () => void;
  readonly emptyText: string;
  /** Bumped by the header's "decision waits" pill: bring the first pending card into view and focus it. */
  readonly showDecision: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(-WINDOW);
  // A signature of the content: new items, and growth inside the newest thread, both count as "something new".
  const last = items.at(-1);
  const signature = `${items.length}:${last?.key ?? ''}:${last?.type === 'thread' ? last.children.length : 0}`;

  const followRef = useRef(follow);
  followRef.current = follow;
  /** The pending decision the view holds at while following (its card's top stays on screen). */
  const hold = useRef<string | null>(null);
  const cardOf = (id: string): HTMLElement | null =>
    scroller.current?.querySelector<HTMLElement>(`[data-gate2-pending="${CSS.escape(id)}"]`) ?? null;
  /** Where following scrolls to: the bottom, or the held card's top when that comes first. */
  const followTop = (el: HTMLElement): number => {
    const card = hold.current === null ? null : cardOf(hold.current);
    if (card === null) return el.scrollHeight;
    return Math.min(el.scrollHeight, card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - HOLD_GAP_PX);
  };
  const stick = (el: HTMLElement): void => {
    el.scrollTop = followTop(el);
  };

  // A pending decision is "seen" only while its clock and buttons are on screen; otherwise a pill points to it.
  const [hidden, setHidden] = useState<readonly string[]>([]);
  // While held at a card, newer lines can sit below it: "Jump to latest" offers them.
  const [below, setBelow] = useState(false);
  const checkPending = useCallback((): void => {
    const root = scroller.current;
    if (root === null) return;
    setBelow(hold.current !== null && root.scrollHeight - root.scrollTop - root.clientHeight > FOLLOW_SLACK_PX);
    const box = root.getBoundingClientRect();
    const ids: string[] = [];
    root.querySelectorAll<HTMLElement>('[data-gate2-pending]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const seen = r.top >= box.top - 4 && r.top + Math.min(r.height, CARD_ACTIONS_PX) <= box.bottom + 4;
      if (!seen) ids.push(el.dataset.gate2Pending ?? '');
    });
    setHidden((prev) => (prev.join(',') === ids.join(',') ? prev : ids));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    if (followRef.current) stick(el);
    // Filtered or short content that fits needs no "Jump to latest".
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX) setFollow(true);
    checkPending();
  }, [signature, checkPending]);

  // A layout change (a resize, a card collapsing to its receipt, "Show all") is not the reader scrolling away: while
  // following, stay put, and let only scrolls at an unchanged size turn following off.
  const size = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (el === null || content === null || content === undefined) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) stick(el);
      size.current = { w: el.clientWidth, h: el.scrollHeight };
      checkPending();
    });
    observer.observe(el);
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [checkPending]);

  // A new decision while following: hold the view at its card. An answered one releases the hold.
  const pendingIds = gate2.filter((g) => g.status === 'pending').map((g) => g.id);
  const pendingKey = pendingIds.join(',');
  // Starts empty: a decision already waiting when the page opens is held in view too.
  const seenPending = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = pendingKey === '' ? [] : pendingKey.split(',');
    const fresh = ids.find((id) => !seenPending.current.has(id));
    seenPending.current = new Set(ids);
    if (hold.current !== null && !ids.includes(hold.current)) hold.current = null;
    if (fresh !== undefined && followRef.current && hold.current === null) hold.current = fresh;
    const el = scroller.current;
    if (el !== null && followRef.current) stick(el);
    checkPending();
  }, [pendingKey, checkPending]);

  const goTo = useCallback((id: string): void => {
    const card = cardOf(id);
    if (card === null) return;
    card.scrollIntoView({ block: card.offsetHeight > (scroller.current?.clientHeight ?? 0) ? 'start' : 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    // Deny is the safe default: the keyboard lands there.
    const buttons = [...card.querySelectorAll<HTMLButtonElement>('[data-gate2-open] button')];
    (buttons.find((b) => b.textContent.trim().startsWith('Deny')) ?? buttons[0])?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const first = pendingKey.split(',')[0];
    if (showDecision > 0 && first !== undefined && first !== '') goTo(first);
    // Only a new request from the header moves the view, not a new pending list.
  }, [showDecision, goTo]);

  const p: ChildProps = { gate2, viewerName, resultsHref, onOpenCall, onOpenPlan };
  const pill =
    'pointer-events-auto inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-4 text-[13px] shadow-float focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus';
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const resized = el.clientWidth !== size.current.w || el.scrollHeight !== size.current.h;
          size.current = { w: el.clientWidth, h: el.scrollHeight };
          checkPending();
          if (resized && followRef.current) {
            stick(el);
            return;
          }
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
          const atHold = hold.current !== null && Math.abs(el.scrollTop - followTop(el)) < FOLLOW_SLACK_PX;
          if (!atHold) hold.current = null;
          setFollow(atBottom || atHold);
        }}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-color:var(--border2)_transparent] [scrollbar-width:thin]"
      >
        {/* Bottom padding keeps the last line clear of the floating pills. */}
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3.5 pb-16 pt-3">
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
      {/* One row of pills. Phones show the pinned gold banner instead of the decision pill. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-wrap items-center justify-center gap-2 px-3">
        {hidden[0] === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              if (hidden[0] !== undefined) goTo(hidden[0]);
            }}
            className={`${pill} border border-gold-ink bg-gold-soft font-semibold text-gold-ink max-md:hidden`}
          >
            <Icon name="hand" size={15} />
            {hidden.length === 1 ? 'A decision waits for you' : `${hidden.length} decisions wait for you`} · Show
          </button>
        )}
        {(follow && !below) || items.length === 0 ? null : (
          <button
            type="button"
            onClick={() => {
              const el = scroller.current;
              if (el === null) return;
              hold.current = null;
              setBelow(false);
              el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
              setFollow(true);
            }}
            // Held at a decision on a phone, the pill would sit on the card's buttons: only offer it there once the
            // reader scrolled away.
            className={`${pill} border border-border bg-card font-medium text-foreground hover:bg-surface-2 ${follow ? 'max-md:hidden' : ''}`}
          >
            <Icon name="chevron" size={14} />
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
});
