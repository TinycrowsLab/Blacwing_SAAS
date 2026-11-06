/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// The Gate 2 decision card (experience spec §6.2): one component for the live conversation, the Decisions inbox and the
// full page. Everything on it is the runner's data or a template: the question, the exact request and body from the
// gate2.requested event, the deterministic whyOutside text. Only the dashed box holds Claude's words.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Chip, Icon, InlineMessage, Receipt } from './design';
import { Countdown, PendingButton, useCountdown } from './design-client';
import {
  DECIDED_EVENT,
  fetchGate2,
  FOOTNOTE,
  Gate2Actions,
  type Gate2Detail,
  postDecision,
} from './gate2-actions';
import { pathOf } from './run-model';
import { useNow } from './use-now';
import { agentName } from '../../lib/agents';
import { gate2DetailSchema, sidebarSchema, type Gate2, type SidebarData } from '../../lib/schemas';

type Card = Gate2 | Gate2Detail;

/** Which audit asked (target name, start time, who started it): shown wherever cards from several audits sit together. */
export interface AuditContext {
  readonly assetName: string | null;
  readonly startedAt: string;
  /** The person who asked for the audit, when known. */
  readonly requester: string | null;
  /** The viewer asked for this audit. */
  readonly mine: boolean;
}

/** "your audit" or "started by Avery": whose audit this is, so requests from two audits never look alike. */
export const whoseAudit = (audit: AuditContext): string =>
  audit.mine
    ? 'your audit'
    : audit.requester === null
      ? 'a teammate’s audit'
      : `${audit.requester}’s audit`;

/** The worker's gate key ends in " as {role}" or " as no test account" (worker hunt/scope.ts gateKey). */
export function roleFromPathKey(pathKey: string): string | null {
  const role = / as (.+)$/.exec(pathKey)?.[1];
  return role === undefined || role === 'no test account' ? null : role;
}

const CHANGES_DATA = new Set(['POST', 'PUT', 'PATCH']);

export const gate2Question = (role: string | null): string =>
  `Allow Claude to send this request ${role === null ? 'without signing in' : `as ${role}`}?`;

/** The runner's whyOutside, with the authorisation's internal term shown as the label people chose it by. */
export const plainWhy = (text: string): string =>
  text.replace(/\bactive-safe\b/g, '“Probe gently”').replace(/\bpassive\b/g, '“Look, don’t touch”');

/** The one plain line before the runner's rule: what the request could do, and how it would be sent. */
export function plainLead(gate2: { method: string }, role: string | null): string {
  const what = CHANGES_DATA.has(gate2.method.toUpperCase())
    ? 'This could change data on the site, and your plan only lets Claude probe gently.'
    : 'This goes beyond what your plan lets Claude do on its own.';
  const how =
    role === null
      ? 'It would go as a visitor, without any test account.'
      : `It would go signed in as your test account “${role}”.`;
  return `${what} ${how}`;
}

/** The latest closed request in the same audit for the same method, path and role (the runner asks again after a no). */
export function earlierDecision(
  gate2: Gate2 | Gate2Detail,
  history: readonly Gate2[],
): Gate2 | null {
  const key = (g: { pathKey: string; method: string; url: string }): string =>
    g.pathKey === '' ? `${g.method} ${g.url}` : g.pathKey;
  const mine = key(gate2);
  const at = (g: Gate2): number => Date.parse(g.decidedAt ?? g.deadlineAt);
  return (
    history
      .filter((g) => g.id !== gate2.id && g.status !== 'pending' && key(g) === mine)
      .filter((g) => gate2.createdAt === undefined || at(g) <= Date.parse(gate2.createdAt) + 1000)
      .sort((a, b) => at(b) - at(a))[0] ?? null
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One time format for the Decisions screens, in the viewer's locale: "8:25 am" today, "6 Nov, 8:25 am" before.
 * Rendered after mount only, so the server's locale never shows (and never mismatches).
 */
export function When({ iso }: { readonly iso: string }) {
  const now = useNow(false);
  if (now === 0) return <time dateTime={iso} />;
  const at = new Date(iso);
  const today = at.toDateString() === new Date(now).toDateString();
  return (
    <time dateTime={iso}>
      {new Intl.DateTimeFormat(undefined, {
        ...(today ? {} : { day: 'numeric', month: 'short' }),
        hour: 'numeric',
        minute: '2-digit',
      }).format(at)}
    </time>
  );
}

// shortcut: the body is clamped by length, not by measured lines; measure once bodies get long and structured.
const BODY_CLAMP_CHARS = 240;
const LINK = 'font-medium text-gold-ink underline-offset-2 hover:underline';

function RequestBox({ gate2, body }: { readonly gate2: Card; readonly body: string | null }) {
  const [open, setOpen] = useState(false);
  const long = body !== null && (body.length > BODY_CLAMP_CHARS || body.split('\n').length > 4);
  return (
    <div className="mt-2 rounded-[10px] border border-border bg-code px-2.5 py-1.5 font-mono text-[12.5px] leading-[19px]">
      <p className="m-0 break-all">
        <span className="font-medium text-slate">{gate2.method}</span> {pathOf(gate2.url)}
      </p>
      {body === null || body === '' ? null : (
        <>
          <p
            className={`m-0 whitespace-pre-wrap break-all text-muted-foreground ${open ? '' : 'line-clamp-4'}`}
          >
            {body}
          </p>
          {long ? (
            <button
              type="button"
              onClick={() => {
                setOpen(!open);
              }}
              className="mt-0.5 font-sans text-[12px] font-medium text-gold-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              {open ? 'Show less' : 'Show all'}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function Chips({ gate2 }: { readonly gate2: Card }) {
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {CHANGES_DATA.has(gate2.method.toUpperCase()) ? <Chip tone="gold">Changes data</Chip> : null}
      {/* Gate 2 only exists in "Probe gently" runs: "Look, don't touch" blocks every state-changing request outright. */}
      {gate2.intrusiveness === 'state_changing' ? (
        <Chip tone="neutral">Above &ldquo;Probe gently&rdquo;</Chip>
      ) : null}
      {/exclu/i.test(gate2.whyOutside) ? <Chip tone="warn">Excluded path</Chip> : null}
    </div>
  );
}

function ClaudeReason({
  reason,
  phone = false,
}: {
  readonly reason: string;
  readonly phone?: boolean;
}) {
  return (
    <div
      className={`border border-dashed border-border-strong bg-code ${phone ? 'rounded-2xl px-[15px] py-[13px]' : 'mt-2.5 rounded-[10px] px-3 py-2'}`}
    >
      <span className="block text-[11.5px] text-muted-foreground">
        Claude&apos;s reason, not verified
      </span>
      <p className="m-0 mt-0.5 text-[13px] leading-5 text-foreground">
        {reason === '' ? 'Claude gave no reason.' : reason}
      </p>
    </div>
  );
}

/** One plain line first, then the runner's own rule (deterministic, so it stays, in muted text). */
function WhyAsked({
  gate2,
  role,
  phone = false,
}: {
  readonly gate2: Card;
  readonly role: string | null;
  readonly phone?: boolean;
}) {
  return (
    <div className={phone ? 'mt-2' : 'mt-2.5'}>
      <p className="m-0 text-[13px] leading-5 text-foreground">
        <span className="font-medium">Why you&apos;re asked: </span>
        {plainLead(gate2, role)}
      </p>
      {gate2.whyOutside === '' ? null : (
        <p className="m-0 mt-0.5 text-[12px] leading-[18px] text-muted-foreground">
          The rule: {plainWhy(gate2.whyOutside)}
        </p>
      )}
    </div>
  );
}

/** "You denied POST /api/Users at 1:11 pm in this audit.": the card remembers, so a second ask never looks like a lost click. */
function Earlier({
  earlier,
  viewerName,
}: {
  readonly earlier: Gate2;
  readonly viewerName: string | null;
}) {
  const time = <When iso={earlier.decidedAt ?? earlier.deadlineAt} />;
  const what = (
    <span className="font-mono text-[12px]">
      {earlier.method} {pathOf(earlier.url)}
    </span>
  );
  const who =
    earlier.decidedBy === null
      ? null
      : earlier.decidedBy === viewerName
        ? 'You'
        : earlier.decidedBy;
  return (
    <p className="m-0 mt-2 flex items-start gap-1.5 rounded-[10px] bg-surface-2 px-2.5 py-1.5 text-[12.5px] leading-5 text-muted-foreground">
      <Icon name="repeat" size={13} className="mt-[3px] shrink-0" />
      <span>
        {earlier.status === 'approved' ? (
          <>
            {who ?? 'Someone'} allowed {what} at {time} in this audit.
          </>
        ) : who === null ? (
          <>
            {what} was denied automatically at {time} in this audit.
          </>
        ) : (
          <>
            {who} denied {what} at {time} in this audit.
          </>
        )}{' '}
        Claude is asking again, for a different reason.
      </span>
    </p>
  );
}

/** The decision, collapsed. A human decision is on the ledger; an automatic denial is the runner's (no ledger row). */
function DecisionReceipt({
  gate2,
  viewerName,
  alreadyDecided,
}: {
  readonly gate2: Card;
  readonly viewerName: string | null;
  readonly alreadyDecided: boolean;
}) {
  const time = <When iso={gate2.decidedAt ?? gate2.deadlineAt} />;
  const detail = (consequence: string) => (
    <>
      <span className="block font-mono text-[12px]">
        {gate2.method} {pathOf(gate2.url)}
      </span>
      <span className="block">{consequence}</span>
      {alreadyDecided ? (
        <span className="block">Already decided in another tab or by a teammate.</span>
      ) : null}
    </>
  );
  const hash = 'audit' in gate2 ? (gate2.audit?.hash ?? null) : null;
  if (gate2.status === 'approved' || (gate2.status === 'denied' && gate2.decidedBy !== null)) {
    const who =
      gate2.decidedBy === null || gate2.decidedBy === viewerName ? 'you' : gate2.decidedBy;
    return gate2.status === 'approved' ? (
      <Receipt
        tone="ok"
        title={
          <>
            Allowed for this run by {who} at {time}
            {gate2.decisionReason === null ? '' : `: “${gate2.decisionReason}”`}
          </>
        }
        detail={detail('Claude may send this method, path and role until the run ends.')}
        hash={hash}
      />
    ) : (
      <Receipt
        tone="bad"
        title={
          <>
            Denied by {who} at {time}
          </>
        }
        detail={detail('Not sent. Claude moves on to its next test.')}
        hash={hash}
      />
    );
  }
  // `denied` without a person: the audit stopped. `expired`, or still `pending` past the deadline: nobody answered.
  // No person decided, so there is no ledger entry: the runner records it in the audit's activity (gate2.decided).
  const stopped = gate2.status === 'denied';
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[14px] border border-border bg-card px-4 py-3"
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-text text-bg">
        <Icon name="x" size={12} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium leading-5 text-foreground">
          Denied automatically at {time} {stopped ? '(the audit stopped)' : '(no answer)'}
        </span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">
          {detail('Not sent. Claude moves on to its next test.')}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          Recorded in the audit&apos;s activity. No one decided, so there is no ledger entry.
        </span>
      </span>
    </div>
  );
}

/** Between the local deadline and the server's word: never show an outcome the server has not confirmed. */
function Checking({ gate2 }: { readonly gate2: Card }) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-[14px] border border-border bg-card px-4 py-3 text-[13.5px] text-muted-foreground"
    >
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-gold-ink motion-reduce:animate-none" />
      Checking the answer for{' '}
      <span className="font-mono text-[12px]">
        {gate2.method} {pathOf(gate2.url)}
      </span>
      …
    </div>
  );
}

const PAGE_POLL_MS = 5000;
const CHECK_RETRY_MS = 2000;

/** Where to go after a decision on the full page: the next thing that waits for this person, this audit's first. */
function useNextDecision(
  active: boolean,
  id: string,
  runId: string,
): { href: string; label: string } | null {
  const [next, setNext] = useState<{ href: string; label: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void fetch('/api/sidebar', { cache: 'no-store' })
      .then(async (res) => (res.ok ? sidebarSchema.safeParse(await res.json()) : null))
      .then((parsed) => {
        if (!live || parsed?.success !== true) return;
        const d = parsed.data;
        const others = d.gate2.filter((x) => x.id !== id);
        const same = others.find((x) => x.runId === runId);
        const g = same ?? others[0];
        const plan = d.plans[0];
        const release = d.releases[0];
        setNext(
          g !== undefined
            ? {
                href: `/decisions/gate2/${g.id}`,
                label:
                  same === undefined
                    ? 'Next decision, from another audit'
                    : 'Next decision in this audit',
              }
            : plan !== undefined
              ? { href: `/audits/${plan.id}`, label: 'Next: a plan to approve' }
              : release !== undefined
                ? { href: `/findings/${release.id}`, label: 'Next: a finding to release' }
                : null,
        );
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [active, id, runId]);
  return next;
}

/** The desktop page's deadline panel (Blackwing Screens Gate 2): a ring of the time left, the clock and what happens. */
function DeadlinePanel({
  gate2,
  audit,
  runLink,
}: {
  readonly gate2: Card;
  readonly audit: AuditContext | null;
  readonly runLink: string;
}) {
  const clock = useCountdown(gate2.deadlineAt, gate2.createdAt);
  const R = 88;
  const C = 2 * Math.PI * R;
  const share = clock?.share ?? 1;
  const stroke =
    clock === null || clock.tone === 'normal'
      ? 'stroke-gold-ink'
      : clock.tone === 'warn'
        ? 'stroke-warn'
        : 'stroke-bad';
  const ink = clock === null || clock.tone === 'normal' ? 'text-foreground!' : '';
  const created = gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt };
  const host = hostOf(gate2.url);
  return (
    <aside className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card px-6 py-6">
      <div className="relative size-[200px]" role="timer" aria-live="off">
        <svg viewBox="0 0 200 200" className="size-full -rotate-90" aria-hidden="true">
          <circle
            cx="100"
            cy="100"
            r={R}
            fill="none"
            strokeWidth="8"
            className="stroke-gold-line"
          />
          <circle
            cx="100"
            cy="100"
            r={R}
            fill="none"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - share)}
            className={`${stroke} transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none`}
          />
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[12.5px] text-muted-foreground">Denied in</span>
          <Countdown
            variant="big"
            deadlineAt={gate2.deadlineAt}
            {...created}
            className={`text-[52px]! leading-[60px]! ${ink}`}
          />
        </span>
      </div>
      <p className="m-0 text-center text-[14px] leading-[21px] text-foreground">
        If no one decides, this request is <b className="font-semibold">denied automatically</b>.
      </p>
      <dl className="m-0 grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border pt-4 text-[12.5px]">
        <dt className="text-muted-foreground">Site</dt>
        <dd className="m-0 truncate text-right text-foreground">{audit?.assetName ?? host}</dd>
        {audit === null ? null : (
          <>
            <dt className="text-muted-foreground">Audit</dt>
            <dd className="m-0 text-right text-foreground">
              {whoseAudit(audit).replace(/^./, (c) => c.toUpperCase())}, started{' '}
              <When iso={audit.startedAt} />
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Asked by</dt>
        <dd className="m-0 text-right text-foreground">{agentName(gate2.agent)}</dd>
      </dl>
      <Link href={runLink} className={`self-start text-[13px] ${LINK}`}>
        Open the live audit
      </Link>
    </aside>
  );
}

/** A request waiting in the inbox, folded to one line so only one question is open at a time. */
function CompactRow({ gate2, onExpand }: { readonly gate2: Card; readonly onExpand: () => void }) {
  const created = gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt };
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={onExpand}
      className="flex min-h-14 w-full items-center gap-3 rounded-[14px] border border-gold-line bg-card px-4 py-2.5 text-left hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
    >
      <Icon name="hand" size={15} className="shrink-0 text-gold-ink" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[12.5px] text-foreground">
          <span className="font-medium text-slate">{gate2.method}</span> {pathOf(gate2.url)}
        </span>
        <span className="truncate text-[12px] text-muted-foreground">
          {agentName(gate2.agent)}
          {gate2.reason === '' ? null : <> · {gate2.reason}</>}
        </span>
      </span>
      <Countdown deadlineAt={gate2.deadlineAt} {...created} className="shrink-0 text-[13px]" />
      <span className="hidden shrink-0 items-center text-[12.5px] font-medium text-gold-ink sm:inline-flex">
        Review
        <Icon name="right" size={14} className="ml-0.5" />
      </span>
    </button>
  );
}

/**
 * `variant="inline"`: the card in the conversation and the inbox. `variant="page"`: the full decision page (a deadline
 * panel beside the card on desktop; prototype 06 on phones: big clock, sticky footer, 56 px Deny). `body` and `asRole`
 * come from the gate2.requested event; without `asRole` the role is read from the request's gate key, which carries
 * the same value. `audit` names the asking audit (the page); `history` is the audit's other requests, so a second ask
 * for the same method, path and role says what was decided before; `gone` says the inbox's last refresh no longer
 * lists it as pending; `compact` folds a waiting request to one line until `onExpand`.
 */
export function Gate2Card({
  gate2,
  body = null,
  asRole,
  variant = 'inline',
  viewerName = null,
  audit = null,
  history = [],
  gone = false,
  compact = false,
  footnote = true,
  onExpand,
  onClosed,
}: {
  readonly gate2: Card;
  readonly body?: string | null;
  readonly asRole?: string | null;
  readonly variant?: 'inline' | 'page';
  readonly viewerName?: string | null;
  readonly audit?: AuditContext | null;
  readonly history?: readonly Gate2[];
  readonly gone?: boolean;
  readonly compact?: boolean;
  readonly footnote?: boolean;
  readonly onExpand?: () => void;
  /** Called once the card shows its receipt (decided here, elsewhere, or by the deadline). */
  readonly onClosed?: (id: string) => void;
}) {
  const [decided, setDecided] = useState<{ gate2: Gate2Detail; already: boolean } | null>(null);
  const [server, setServer] = useState<Gate2Detail | null>(null);
  const [checks, setChecks] = useState(0);
  const [due, setDue] = useState(false);
  const receiptRef = useRef<HTMLDivElement>(null);
  const page = variant === 'page';
  // A closed request from the props (the run's own poll) beats an older pending answer from this card's checks.
  const current: Card = decided?.gate2 ?? (gate2.status !== 'pending' ? gate2 : (server ?? gate2));
  const clock = useCountdown(gate2.deadlineAt, gate2.createdAt);
  const pending = current.status === 'pending';
  const confirmedExpired = pending && server !== null && server.secondsLeft === 0;
  // Dropped from the inbox but the server still has it open (and in time): it is still a question, not a receipt.
  const stillOpen =
    checks > 0 && server !== null && server.status === 'pending' && server.secondsLeft > 0;
  const needsCheck =
    pending &&
    !confirmedExpired &&
    (due || (clock !== null && clock.secondsLeft === 0) || (gone && !stillOpen));
  const closed = !pending || confirmedExpired;
  const role = asRole === undefined ? roleFromPathKey(gate2.pathKey) : asRole;
  const question = gate2Question(role);
  const id = gate2.id;
  const earlier = earlierDecision(gate2, history);
  const wasOpen = useRef(!closed);

  // The buttons that had the focus are gone once decided: keep the keyboard on the receipt instead of the page top.
  useEffect(() => {
    if (decided !== null) receiptRef.current?.focus({ preventScroll: true });
  }, [decided]);
  useEffect(() => {
    if (!closed) return;
    onClosed?.(id);
    // Closed by the deadline or elsewhere while open here: the sidebar and the counts catch up now, not at their poll.
    if (wasOpen.current && decided === null && !gone) window.dispatchEvent(new Event('bw:refresh'));
    wasOpen.current = false;
  }, [closed, onClosed, id, decided, gone]);

  // The 1 s clock can show 0:01 for up to a second past the deadline: a timer at the deadline itself starts the check.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(
      () => {
        setDue(true);
      },
      Math.max(0, Date.parse(gate2.deadlineAt) - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [pending, gate2.deadlineAt]);

  // Decided in this tab by another card for the same request, or by "Deny all".
  useEffect(() => {
    const on = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const g = gate2DetailSchema.safeParse(e.detail);
      if (g.success && g.data.id === id && g.data.status !== 'pending')
        setDecided((d) => d ?? { gate2: g.data, already: false });
    };
    window.addEventListener(DECIDED_EVENT, on);
    return () => {
      window.removeEventListener(DECIDED_EVENT, on);
    };
  }, [id]);

  // The deadline passed here, or the inbox stopped listing it: ask the server what happened before saying so.
  useEffect(() => {
    if (!needsCheck) return;
    let live = true;
    const timer = window.setTimeout(
      () => {
        void fetchGate2(id).then((g) => {
          if (!live) return;
          if (g !== null) setServer(g);
          setChecks((c) => c + 1);
        });
      },
      checks === 0 ? 0 : CHECK_RETRY_MS,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [needsCheck, checks, id]);

  // The full page has no list refresh: it re-reads the request on mount (a Back from the router cache), every 5 s
  // while visible, when shown again and on `bw:refresh`, so a decision made elsewhere shows within seconds.
  useEffect(() => {
    if (!page || !pending) return;
    let live = true;
    const read = (): void => {
      if (document.visibilityState !== 'visible') return;
      void fetchGate2(id).then((g) => {
        if (live && g !== null) setServer(g);
      });
    };
    read();
    const timer = window.setInterval(read, PAGE_POLL_MS);
    window.addEventListener('bw:refresh', read);
    window.addEventListener('pageshow', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('bw:refresh', read);
      window.removeEventListener('pageshow', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [page, pending, id]);

  const next = useNextDecision(page && closed, id, gate2.runId);

  const done = (g: Gate2Detail, already: boolean): void => {
    setDecided({ gate2: g, already });
  };

  if (needsCheck) return <Checking gate2={current} />;

  const runLink = `/runs/${gate2.runId}`;
  if (closed) {
    const receipt = (
      <div ref={receiptRef} tabIndex={-1} className="rounded-[14px] focus:outline-none">
        <DecisionReceipt
          gate2={current}
          viewerName={viewerName}
          alreadyDecided={decided?.already ?? false}
        />
      </div>
    );
    if (!page) return receipt;
    const follow = `inline-flex min-h-11 items-center md:min-h-0 ${LINK}`;
    return (
      <div className="flex max-w-[880px] flex-col gap-4">
        <h1 className="m-0 text-[22px] font-semibold leading-[30px] text-foreground md:hidden">
          {audit?.assetName ?? 'Request during an audit'}
        </h1>
        {receipt}
        {/* Phones stack the follow-ups (Next first, as a full-width button); desktop keeps one line of links. */}
        <div className="flex flex-col gap-1 text-[13px] md:flex-row md:flex-wrap md:gap-x-5">
          {next === null ? null : (
            <Link
              href={next.href}
              className={`max-md:mb-1 max-md:h-12 max-md:justify-center max-md:rounded-[14px] max-md:border max-md:border-input-strong max-md:bg-card max-md:text-[14px] max-md:text-foreground ${follow}`}
            >
              {next.label}
              <Icon name="right" size={14} className="ml-1" />
            </Link>
          )}
          <Link href={runLink} className={follow}>
            Open the audit
          </Link>
          <Link href="/decisions" className={follow}>
            All decisions
          </Link>
        </div>
      </div>
    );
  }

  if (compact && onExpand !== undefined) return <CompactRow gate2={gate2} onExpand={onExpand} />;

  // Prototypes 04 and 06 draw the clock in ink; it turns warn under 60 s and bad under 15 s.
  const ink = clock === null || clock.tone === 'normal' ? 'text-foreground!' : '';
  const created = gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt };
  const bar = <Countdown variant="bar" deadlineAt={gate2.deadlineAt} {...created} />;
  const card = (
    <section
      role="alertdialog"
      aria-label={`Your decision: ${question}`}
      data-gate2-scope=""
      className="overflow-hidden rounded-2xl border-[1.5px] border-gold-ink bg-card shadow-[0_10px_30px_rgba(138,99,16,.12)]"
    >
      <header className="flex min-h-10 items-center gap-2.5 border-b border-gold-line bg-gold-soft px-4 py-2">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-gold-ink">
          <Icon name="hand" size={15} />
          Your decision
        </span>
        {/* The page's deadline panel carries the big clock; the card repeats it only where it stands alone. */}
        {page ? null : (
          <span className="ml-auto flex items-baseline gap-1.5" role="timer" aria-live="off">
            <Countdown
              deadlineAt={gate2.deadlineAt}
              {...created}
              suffix=""
              className={`text-[19px] leading-6 ${ink}`}
            />
            <small className="text-[11.5px] text-muted-foreground">
              left, then it&apos;s denied
            </small>
          </span>
        )}
      </header>
      {bar}
      <div className="grid gap-4 px-4 pb-3.5 pt-3 md:grid-cols-[minmax(0,1fr)_220px] md:has-[[data-allowing]]:grid-cols-1">
        <div className="min-w-0">
          <h3 className="m-0 text-[15.5px] font-semibold leading-[23px] text-foreground">
            {question}
          </h3>
          {page ? null : (
            <p className="m-0 mt-0.5 text-[12.5px] leading-5 text-muted-foreground">
              Asked by {agentName(gate2.agent)}
            </p>
          )}
          {earlier === null ? null : <Earlier earlier={earlier} viewerName={viewerName} />}
          <RequestBox gate2={gate2} body={body} />
          <Chips gate2={gate2} />
          <WhyAsked gate2={gate2} role={role} />
          <ClaudeReason reason={gate2.reason} />
        </div>
        <Gate2Actions
          gate2Id={id}
          deadlineAt={gate2.deadlineAt}
          createdAt={gate2.createdAt}
          layout="column"
          autoFocus={page}
          footnote={footnote}
          onDecided={done}
        />
      </div>
    </section>
  );
  if (!page) return card;

  const host = hostOf(gate2.url);
  return (
    <>
      <div className="hidden max-w-[1120px] items-start gap-5 md:grid md:grid-cols-[minmax(0,1fr)_280px]">
        {card}
        <DeadlinePanel gate2={gate2} audit={audit} runLink={runLink} />
      </div>

      <div
        data-gate2-scope=""
        className="-mx-4 -mb-5 -mt-5 flex min-h-[calc(100dvh-52px)] flex-col bg-surface-2 md:hidden"
      >
        {/* Sticky under the 52 px top bar, so the time left never scrolls away. */}
        <div className="sticky top-[52px] z-30 h-1 [&>div]:h-1">{bar}</div>
        <div
          className="flex flex-col items-center px-5 pb-1 pt-3.5 text-center"
          role="timer"
          aria-live="off"
        >
          <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-gold-ink">
            <Icon name="hand" size={14} />
            Your decision
          </span>
          <Countdown variant="big" deadlineAt={gate2.deadlineAt} {...created} className={ink} />
          <span className="text-[13.5px] text-muted-foreground">
            No answer means <b className="font-semibold text-foreground">denied</b>
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-2.5 px-4 pb-4 pt-3">
          <section className="rounded-2xl border border-border bg-card px-[15px] py-[13px]">
            <h1 className="m-0 text-base font-semibold leading-[23px] text-foreground">
              {question}
            </h1>
            {earlier === null ? null : <Earlier earlier={earlier} viewerName={viewerName} />}
            <RequestBox gate2={gate2} body={body} />
            <Chips gate2={gate2} />
          </section>
          <ClaudeReason reason={gate2.reason} phone />
          <section className="rounded-2xl border border-border bg-card px-[15px] py-[13px]">
            <span className="block text-[11.5px] text-muted-foreground">
              {audit?.assetName ?? host}
              {audit === null ? null : <> · {whoseAudit(audit)}</>} · {agentName(gate2.agent)}
            </span>
            <WhyAsked gate2={gate2} role={role} phone />
            <Link
              href={runLink}
              className="mt-1 inline-flex min-h-11 items-center text-[13px] font-medium text-gold-ink"
            >
              Open the live audit
            </Link>
          </section>
        </div>
        <div className="sticky bottom-0 border-t border-border bg-bg px-4 pb-[22px] pt-3">
          <Gate2Actions
            gate2Id={id}
            deadlineAt={gate2.deadlineAt}
            createdAt={gate2.createdAt}
            layout="sheet"
            autoFocus={false}
            onDecided={done}
          />
        </div>
      </div>
    </>
  );
}

/** `asRole` undefined: the event was not found, so the card reads the role from the gate key. */
export interface InboxItem {
  readonly gate2: Gate2;
  readonly body: string | null;
  readonly asRole?: string | null | undefined;
  readonly audit: AuditContext | null;
  /** The audit's other Gate 2 requests (for "You denied this earlier"). */
  readonly history: readonly Gate2[];
}

/** A Decisions section heading: plain title, a gold count when above 0, the technical term in mono, one lede line. */
export function InboxHeading({
  title,
  term,
  lede,
  count,
}: {
  readonly title: string;
  readonly term: string;
  readonly lede: string;
  readonly count: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold text-foreground">
        {title}
        {count > 0 ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gold-soft px-1.5 text-[11.5px] font-semibold tabular-nums text-gold-ink">
            {count}
          </span>
        ) : null}
        <span className="font-mono text-[11px] font-normal text-muted-foreground">{term}</span>
      </h2>
      <p className="m-0 text-[13px] text-muted-foreground">{lede}</p>
    </div>
  );
}

const INBOX_TITLE = 'Requests during an audit';

/** Fresh data for the cards already shown, in their places; new requests join at the end. */
function merge(seen: readonly InboxItem[], items: readonly InboxItem[]): readonly InboxItem[] {
  const fresh = new Map(items.map((i) => [i.gate2.id, i]));
  const kept = seen.map((s) => fresh.get(s.gate2.id) ?? s);
  const known = new Set(seen.map((s) => s.gate2.id));
  return [...kept, ...items.filter((i) => !known.has(i.gate2.id))];
}

/** The cards of one audit together, audits in the order they first showed (soonest deadline first). */
function byAudit(items: readonly InboxItem[]): readonly (readonly InboxItem[])[] {
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) {
    const g = groups.get(item.gate2.runId);
    if (g === undefined) groups.set(item.gate2.runId, [item]);
    else g.push(item);
  }
  return [...groups.values()];
}

/** One audit's header: which site, whose audit, when it started; the live audit; "Deny all" when several wait. */
function AuditHeader({
  item,
  openIds,
}: {
  readonly item: InboxItem;
  readonly openIds: readonly string[];
}) {
  const [failed, setFailed] = useState(0);
  const { audit } = item;
  const denyAll = async (): Promise<void> => {
    setFailed(0);
    const results = await Promise.all(openIds.map((id) => postDecision(id, 'deny', '')));
    for (const r of results)
      if (r.ok) window.dispatchEvent(new CustomEvent(DECIDED_EVENT, { detail: r.gate2 }));
    setFailed(results.filter((r) => !r.ok).length);
    window.dispatchEvent(new Event('bw:refresh'));
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="m-0 min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground">
            {audit?.assetName ?? hostOf(item.gate2.url)}
          </span>
          {audit === null ? null : (
            <>
              {' '}
              · {whoseAudit(audit)}, started <When iso={audit.startedAt} />
            </>
          )}
        </p>
        <Link href={`/runs/${item.gate2.runId}`} className={`text-[12.5px] ${LINK}`}>
          Open the live audit
        </Link>
        {openIds.length < 2 ? null : (
          <PendingButton
            variant="secondary"
            pendingLabel="Denying…"
            onAction={denyAll}
            className="h-8 px-3 text-[12.5px]"
          >
            Deny all {openIds.length}
          </PendingButton>
        )}
      </div>
      {failed === 0 ? null : (
        <InlineMessage tone="bad">
          Couldn&apos;t deny {failed} of them. They&apos;re still open: try again or decide each
          one.
        </InlineMessage>
      )}
    </div>
  );
}

/**
 * The inbox's Gate 2 section. The server sends what is pending (soonest deadline first), grouped here by audit. Only
 * the soonest open request is unfolded (plus any the person opens), like one question at a time; the footnote shows
 * once. Every card keeps its place until the person leaves the page: decided here, elsewhere or by the deadline, it
 * turns into its receipt where it was, so the next request never slides under the cursor. D and A act on the open card
 * in view (the one with the ring).
 */
export function Gate2Inbox({
  items,
  viewerName,
}: {
  readonly items: readonly InboxItem[];
  readonly viewerName: string;
}) {
  const [seen, setSeen] = useState<readonly InboxItem[]>(items);
  const [prev, setPrev] = useState(items);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (items !== prev) {
    setPrev(items);
    setSeen(merge(seen, items));
  }
  const listed = new Set(items.map((i) => i.gate2.id));
  const isOpen = (i: InboxItem): boolean => !closed.has(i.gate2.id) && listed.has(i.gate2.id);
  const open = items.filter((i) => !closed.has(i.gate2.id)).length;
  const onClosed = (id: string): void => {
    setClosed((s) => (s.has(id) ? s : new Set(s).add(id)));
  };
  if (seen.length === 0) return null;
  const groups = byAudit(seen);
  const first = groups.flat().find((i) => isOpen(i))?.gate2.id;
  return (
    <section className="flex flex-col gap-3" aria-label={INBOX_TITLE}>
      <InboxHeading
        title={INBOX_TITLE}
        term="Gate 2"
        lede="Claude wants to send something that could change data. No answer means denied."
        count={open}
      />
      {groups.map((group) => {
        const head = group[0];
        if (head === undefined) return null;
        return (
          <div key={head.gate2.runId} className="flex flex-col gap-2">
            <AuditHeader
              item={head}
              openIds={group.filter((i) => isOpen(i)).map((i) => i.gate2.id)}
            />
            {group.map((item) => {
              const id = item.gate2.id;
              return (
                <Gate2Card
                  key={id}
                  gate2={item.gate2}
                  body={item.body}
                  {...(item.asRole === undefined ? {} : { asRole: item.asRole })}
                  viewerName={viewerName}
                  history={item.history}
                  gone={!listed.has(id)}
                  compact={id !== first && !expanded.has(id)}
                  footnote={false}
                  onExpand={() => {
                    setExpanded((s) => new Set(s).add(id));
                  }}
                  onClosed={onClosed}
                />
              );
            })}
          </div>
        );
      })}
      {open === 0 ? null : (
        <p className="m-0 text-[12px] leading-[18px] text-muted-foreground">{FOOTNOTE}</p>
      )}
    </section>
  );
}

const INBOX_POLL_MS = 5000;
// shortcut: plain fallback refresh for what the sidebar slice does not carry (kept-back findings, bodies); a server
// push replaces both polls once the API streams workspace events.
const INBOX_FULL_MS = 30_000;

/** What waits, by id, as the sidebar slice carries it (the server page passes the same slice it rendered from). */
export interface Waiting {
  readonly gate2: readonly string[];
  readonly plans: readonly string[];
  readonly releases: readonly string[];
}

const signature = (w: Waiting): string =>
  [w.gate2, w.plans, w.releases].map((ids) => [...ids].sort().join(',')).join('|');
const waitingOf = (d: SidebarData): Waiting => ({
  gate2: d.gate2.map((g) => g.id),
  plans: d.plans.map((p) => p.id),
  releases: d.releases.map((r) => r.id),
});

/**
 * Keeps a server-rendered inbox fresh without re-rendering it every tick: every 5 s while the tab is visible (and on
 * return and on `bw:refresh`) it reads the small sidebar slice and refreshes the page only when what waits changed,
 * plus once every 30 s. The page reads every asking audit's events, so refreshing it blindly ran the rate limit dry.
 */
export function InboxRefresh({ waiting }: { readonly waiting: Waiting }) {
  const router = useRouter();
  const current = useRef(signature(waiting));
  const now = signature(waiting);
  useEffect(() => {
    current.current = now;
  }, [now]);
  useEffect(() => {
    let last = Date.now();
    let busy = false;
    const tick = (): void => {
      if (document.visibilityState !== 'visible' || busy) return;
      busy = true;
      void fetch('/api/sidebar', { cache: 'no-store' })
        .then(async (res) => (res.ok ? sidebarSchema.safeParse(await res.json()) : null))
        .then((parsed) => {
          const changed =
            parsed?.success === true && signature(waitingOf(parsed.data)) !== current.current;
          if (changed || Date.now() - last >= INBOX_FULL_MS) {
            last = Date.now();
            router.refresh();
          }
        })
        .catch(() => null)
        .finally(() => {
          busy = false;
        });
    };
    const timer = window.setInterval(tick, INBOX_POLL_MS);
    window.addEventListener('bw:refresh', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('bw:refresh', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router]);
  return null;
}
