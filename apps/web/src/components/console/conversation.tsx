/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// The conversation (experience spec §5.2 item 5): the agents' real exchange, read from the run's events. The planner
// delegates (Planner → specialist, its instruction in a bubble), the specialist's turns, calls and Gate 2 requests nest
// under it, and its report closes the thread. Three voices are never blurred: Blackwing AI (slate tag, its own words, not
// verified), Blackwing (crow tile, template lines from host-lines.ts) and the validator (green, deterministic replay).
// It follows the newest item while the reader is at the bottom; otherwise "Jump to latest" shows. A new decision that
// arrives while following holds the view at its card (the clock and buttons stay on screen) until it is answered or
// the reader scrolls away.
import Link from 'next/link';
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { buttonClass, Icon, SeverityChip, VoiceTag, withRedactions } from './design';
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
  chipGroups,
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
/** A pending card counts as seen while this much of it (its header and clock) is on screen. */
const CARD_SEEN_PX = 56;
/** A click this soon after "Show n more" lands on a row that slid under the pointer: ignore it. */
const TOGGLE_GUARD_MS = 450;
/** The host lines that end a run; each carries the "See results" next step. */
const END_KINDS: ReadonlySet<string> = new Set(['run.completed', 'run.killed', 'run.failed']);

const noSubscribe = (): (() => void) => () => undefined;
/** False during the server render and hydration, true after: times are formatted in the viewer's own clock. */
function useMounted(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** The one clock format of the run page: "8:47 am" in the viewer's locale and time zone. */
export const shortTime = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

function SentAt({ at }: { readonly at: string }) {
  const mounted = useMounted();
  return <time dateTime={at}>{mounted ? shortTime(at) : ''}</time>;
}

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
  // One quiet group with hairlines, not a stack of boxes (prototype 04).
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1 pl-8">
      <ul className="m-0 w-full list-none divide-y divide-border overflow-hidden rounded-[8px] border border-border bg-surface p-0">
        {shown.map((c, i) => (
          <li key={c.seq}>
            {c.blocked ? (
              <div className="flex min-h-[30px] items-center gap-2.5 bg-warn-soft px-2.5 py-1 text-[11.5px] text-warn">
                <Icon name="lock" size={12} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">Blocked by scope: not sent</span> ({ruleWords(c.rule ?? '')})
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {c.method} {withRedactions(c.path)}
                  </span>
                </span>
              </div>
            ) : (
              <button
                type="button"
                disabled={c.exchangeId === null}
                onClick={() => {
                  // Only rows "Show n more" just slid under the pointer ignore a click that fast; the first rows never move.
                  const slid = i >= CALLS_SHOWN && Date.now() - toggledAt.current < TOGGLE_GUARD_MS;
                  if (c.exchangeId !== null && !slid) onOpen(c.exchangeId);
                }}
                title="Open the request and response"
                className="flex h-[30px] w-full max-md:h-11 items-center gap-2.5 px-2.5 text-left font-mono text-[11.5px] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-default"
              >
                <span className="font-medium text-slate">{c.method}</span>
                <span className="min-w-0 flex-1 truncate">
                  {withRedactions(c.path)}
                  {c.asRole === null ? null : <span className="text-muted-foreground"> · as {c.asRole}</span>}
                </span>
                <span className={`rounded-[5px] px-1.5 py-px text-[10.5px] font-medium ${statusTone(c.status ?? 0)}`}>{c.status}</span>
                <span className="w-12 text-right text-[10.5px] text-muted-foreground">{c.ms} ms</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {calls.length > CALLS_SHOWN ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => {
            toggledAt.current = Date.now();
            setAll(!all);
          }}
          className="py-0.5 text-[12px] font-medium text-gold-ink hover:underline max-md:min-h-11"
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
        {/* Calls alone are the runner's measurements, not Blackwing AI's words: say what they are. */}
        {turn.text === null && turn.tools.length === 0 ? (
          <>
            <span className="text-muted-foreground">
              sent {turn.calls.length === 1 ? 'a request' : `${turn.calls.length.toLocaleString('en-US')} requests`}
            </span>
            <VoiceTag voice="blackwing" title="Each request as the runner recorded it">
              Recorded by Blackwing
            </VoiceTag>
          </>
        ) : (
          <VoiceTag voice="claude" />
        )}
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
          {chipGroups(turn.tools).map((t, i) => (
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
          <p className="m-0 flex items-start gap-2 rounded-[10px] bg-slate-soft px-3 py-[7px] text-[13px] text-slate">
            <span aria-hidden="true" className="mt-[5px] size-2.5 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]" />
            <span>
              Proving: replay {Math.min(v.replays, VALIDATOR_REPLAYS)} of {VALIDATOR_REPLAYS}
              {v.control === null ? '' : ` · Negative control: ${v.control.matched ? 'it matched too' : 'behaved as expected'} (${v.control.status})`}
            </span>
          </p>
        ) : v.verdict === 'proven' ? (
          <p className="m-0 flex items-start gap-2 rounded-[10px] bg-ok-soft px-3 py-[7px] text-[13px] text-ok">
            <span aria-hidden="true" className="mt-[5px] size-2.5 shrink-0 rounded-full border-2 border-current" />
            <span>
              <b className="font-semibold">Proven.</b> Replayed {v.matched} of {Math.max(v.replays, v.matched)} times; the control behaved as expected.{' '}
              {v.autoReleased ? 'Released automatically.' : 'Waits for your release.'}
            </span>
          </p>
        ) : (
          <p className="m-0 flex items-start gap-2 rounded-[10px] border border-dashed border-border-strong bg-surface-2 px-3 py-[7px] text-[13px] text-muted-foreground">
            <span aria-hidden="true" className="mt-[5px] size-2.5 shrink-0 rounded-full border-2 border-dashed border-current" />
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
  // The run's last line carries the one next step (spec §5.2): gold for a finished run, quiet for a stopped one.
  const finished = item.kind === 'run.completed';
  const end = END_KINDS.has(item.kind);
  // The runner's own warning (no request used the test accounts): amber, so it is seen while the run goes on.
  const warn = item.kind === 'accounts.unused';
  return (
    <div
      className={`flex items-start gap-2.5 text-[12.5px] leading-[19px] ${finished ? 'rounded-[12px] border border-gold-line bg-gold-soft p-3' : end ? 'rounded-[12px] border border-border bg-surface-2 p-3' : ''}`}
    >
      <CrowTile />
      <span className={end ? 'flex flex-1 flex-wrap items-center gap-3 font-medium text-foreground' : warn ? 'font-medium text-warn' : 'text-muted-foreground'}>
        {item.text}
        {item.kind === 'plan.cases' && onOpenPlan !== null ? (
          <>
            {' '}
            <button type="button" onClick={onOpenPlan} className="font-medium text-gold-ink hover:underline max-md:min-h-11">
              Open the test plan
            </button>
          </>
        ) : null}
        {end && resultsHref !== null ? (
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
          <div data-gate2-row={row.id} data-gate2-pending={row.status === 'pending' ? row.id : undefined}>
            <Gate2Card
              gate2={row}
              body={item.body}
              asRole={item.asRole}
              viewerName={p.viewerName}
              autoFocus={p.gate2.find((g) => g.status === 'pending')?.id === row.id}
            />
            {/* The runner did not wait on this ask: say whether the allowed request was actually sent, and when. */}
            {item.nonBlocking && row.status === 'approved' ? (
              <p className="m-0 ml-8 mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Icon name={item.sentAt === null ? 'clock' : 'check'} size={12} className="shrink-0" />
                {item.sentAt === null ? (
                  item.runEnded ? 'Allowed · not used before the audit ended' : 'Allowed · not used yet'
                ) : (
                  <>
                    Allowed · sent at <SentAt at={item.sentAt} />
                  </>
                )}
              </p>
            ) : null}
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
      {thread.continued ? (
        // The same delegation, picked up again below what happened in between.
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
          <span aria-hidden="true" className="flex w-6 shrink-0 justify-center">
            <Icon name="reply" size={13} className="-scale-x-100" />
          </span>
          <span className="truncate">
            <span className="font-medium text-foreground">{agentName(thread.to)}</span>, continuing the {agentName(thread.from)}&apos;s task
          </span>
        </div>
      ) : (
        <>
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
        </>
      )}
      {thread.children.length === 0 ? null : (
        <div className={`ml-3 flex flex-col gap-3 border-l-2 border-border pl-[18px] max-md:ml-1 max-md:pl-2.5 ${thread.continued ? 'mt-1.5' : 'mt-2.5'}`}>
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
  waitingFirst = false,
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
  /** The run is live and no agent has spoken yet: a quiet moving line says so (spec §8). */
  readonly waitingFirst?: boolean;
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
      const visible = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      if (visible < Math.min(r.height, CARD_SEEN_PX) - 4) ids.push(el.dataset.gate2Pending ?? '');
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
    const el = scroller.current;
    if (hold.current !== null && !ids.includes(hold.current)) {
      // The held decision was answered: keep its receipt where the reader is looking, not jump to the bottom.
      const receipt = el?.querySelector<HTMLElement>(`[data-gate2-row="${CSS.escape(hold.current)}"]`) ?? null;
      hold.current = null;
      if (receipt !== null && el !== null && el.scrollHeight - el.clientHeight - el.scrollTop > FOLLOW_SLACK_PX) {
        followRef.current = false;
        setFollow(false);
        receipt.scrollIntoView({ block: 'nearest' });
      }
    }
    if (fresh !== undefined && followRef.current && hold.current === null) hold.current = fresh;
    if (el !== null && followRef.current) stick(el);
    checkPending();
  }, [pendingKey, checkPending]);

  // Answering a decision (a click or focus inside its card) stops following: new lines arriving below must never
  // scroll the card, its reason field or its confirm button away while the person is using them.
  const release = (target: EventTarget): void => {
    if (!(target instanceof Element) || target.closest('[data-gate2-pending]') === null) return;
    hold.current = null;
    followRef.current = false;
    setFollow(false);
  };

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

  // D or A with every pending card scrolled out of view: bring the first one into view (keys then answer it) instead
  // of staying silent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      if ((key !== 'd' && key !== 'a') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      const ids = pendingKey === '' ? [] : pendingKey.split(',');
      const box = scroller.current?.getBoundingClientRect();
      if (ids.length === 0 || box === undefined) return;
      const shown = ids.some((id) => {
        const r = cardOf(id)?.getBoundingClientRect();
        return r !== undefined && r.bottom > box.top && r.top < box.bottom;
      });
      const first = ids[0];
      if (shown || first === undefined) return;
      e.preventDefault();
      goTo(first);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [pendingKey, goTo]);

  // A decision already waiting when the page opens is brought into view once (never taken from a reader who scrolled):
  // D and A answer only a card that is on screen, so a card parked below the fold would leave them silent.
  const openedAtCard = useRef(false);
  useEffect(() => {
    if (openedAtCard.current) return;
    const first = pendingKey.split(',')[0];
    if (first === undefined || first === '') return;
    const card = cardOf(first);
    if (card === null) return;
    openedAtCard.current = true;
    card.scrollIntoView({ block: card.offsetHeight > (scroller.current?.clientHeight ?? 0) ? 'start' : 'center' });
    checkPending();
  }, [pendingKey, checkPending]);

  // Typing a reason in a decision card: no floating pill may sit on the field.
  const [editing, setEditing] = useState(false);
  const p: ChildProps = { gate2, viewerName, resultsHref, onOpenCall, onOpenPlan };
  const waiting = pendingKey === '' ? 0 : pendingKey.split(',').length;
  const decisionPill =
    hidden.length === 0
      ? null
      : hidden.length < waiting
        ? `${hidden.length === 1 ? 'One more decision waits' : `${hidden.length} more decisions wait`} for you · Show`
        : `${hidden.length === 1 ? 'A decision waits' : `${hidden.length} decisions wait`} for you · Show`;
  // The decision pill is the more important target: never both, so "Jump to latest" never points past a decision.
  const jump = !(follow && !below) && items.length > 0 && decisionPill === null;
  // The run's last line carries the gold next step; while it is scrolled out of view (say, after Stop held the view at
  // a decision's receipt) the strip carries it instead, so a finished or stopped run always shows exactly one.
  const ended = resultsHref !== null && items.some((i) => i.type === 'host' && END_KINDS.has(i.kind));
  const pills = !editing && (decisionPill !== null || jump);
  const pill =
    'inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-4 text-[13px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus';
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
        onFocus={(e) => {
          setEditing(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement);
          release(e.target);
        }}
        onPointerDown={(e) => {
          release(e.target);
        }}
        onBlur={() => {
          setEditing(false);
        }}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-color:var(--border2)_transparent] [scrollbar-width:thin]"
      >
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3.5 pb-6 pr-2 pt-3">
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
          {waitingFirst && shown.length > 0 ? (
            <div role="status" className="flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
              <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
                <span className="size-3 rounded-full border-2 border-border-strong border-t-gold-ink motion-safe:animate-[bwspin_0.9s_linear_infinite]" />
              </span>
              Waiting for the first agent…
            </div>
          ) : null}
        </div>
      </div>
      {/* The pills get their own strip under the log (never on top of a line or a card's buttons). Phones show the
          pinned gold banner instead of the decision pill. */}
      {pills ? (
        <div className={`flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-border px-3 py-1.5 ${jump ? '' : 'max-md:hidden'}`}>
          {hidden[0] === undefined || decisionPill === null ? null : (
            <button
              type="button"
              onClick={() => {
                if (hidden[0] !== undefined) goTo(hidden[0]);
              }}
              className={`${pill} border border-gold-ink bg-gold-soft font-semibold text-gold-ink max-md:hidden`}
            >
              <Icon name="hand" size={15} />
              {decisionPill}
            </button>
          )}
          {jump && ended ? (
            <Link href={resultsHref} className={buttonClass('primary', 'h-9 px-4')}>
              See results
              <Icon name="arrow" size={14} />
            </Link>
          ) : null}
          {jump ? (
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
              className={`${pill} border border-border bg-card font-medium text-foreground hover:bg-surface-2`}
            >
              <Icon name="chevron" size={14} />
              Jump to latest
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
