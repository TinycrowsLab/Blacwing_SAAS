/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// The Gate 2 decision card (experience spec §6.2): one component for the live conversation, the Decisions inbox and the
// full page. Everything on it is the runner's data or a template: the question, the exact request and body from the
// gate2.requested event, the deterministic whyOutside text. Only the dashed box holds Claude's words.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Chip, Icon, Receipt } from './design';
import { Countdown, useCountdown } from './design-client';
import { fetchGate2, Gate2Actions, type Gate2Detail } from './gate2-actions';
import { pathOf } from './run-model';
import { useNow } from './use-now';
import { agentName } from '../../lib/agents';
import { sidebarSchema, type Gate2 } from '../../lib/schemas';

type Card = Gate2 | Gate2Detail;

/** Which audit asked (target name, start time): shown wherever cards from several audits sit together. */
export interface AuditContext {
  readonly assetName: string | null;
  readonly startedAt: string;
}

/** The worker's gate key ends in " as {role}" or " as no test account" (worker hunt/scope.ts gateKey). */
export function roleFromPathKey(pathKey: string): string | null {
  const role = / as (.+)$/.exec(pathKey)?.[1];
  return role === undefined || role === 'no test account' ? null : role;
}

export const gate2Question = (role: string | null): string =>
  `Allow Claude to send this request ${role === null ? 'without signing in' : `as ${role}`}?`;

/** The runner's whyOutside, with the authorisation's internal term shown as the label people chose it by. */
export const plainWhy = (text: string): string =>
  text.replace(/\bactive-safe\b/g, '“Probe gently”').replace(/\bpassive\b/g, '“Look, don’t touch”');

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

const CHANGES_DATA = new Set(['POST', 'PUT', 'PATCH']);
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

function WhyAsked({ text }: { readonly text: string }) {
  return text === '' ? null : (
    <p className="m-0 mt-2.5 text-[12px] leading-[18px] text-muted-foreground">
      <span className="font-medium text-foreground">Why you&apos;re asked: </span>
      {plainWhy(text)}
    </p>
  );
}

/** "Juice Shop lab · audit started 8:19 am · 127.0.0.1:3001 · asked by Recon": which audit is asking. */
function AuditLine({
  gate2,
  audit,
  links,
}: {
  readonly gate2: Card;
  readonly audit: AuditContext;
  readonly links?: ReactNode;
}) {
  const host = hostOf(gate2.url);
  return (
    <p className="m-0 mt-1 text-[12.5px] leading-5 text-muted-foreground">
      <span className="font-medium text-foreground">{audit.assetName ?? host}</span> · audit started{' '}
      <When iso={audit.startedAt} />
      {audit.assetName === null ? null : <> · {host}</>} · asked by {agentName(gate2.agent)}
      {links}
    </p>
  );
}

/** The decision, collapsed. A human decision is on the ledger; an automatic denial is the runner's (no ledger row). */
function DecisionReceipt({
  gate2,
  viewerName,
  alreadyDecided,
  audit,
}: {
  readonly gate2: Card;
  readonly viewerName: string | null;
  readonly alreadyDecided: boolean;
  readonly audit: AuditContext | null;
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
      {audit === null ? null : (
        <span className="block">
          {audit.assetName ?? hostOf(gate2.url)} · audit started <When iso={audit.startedAt} />
        </span>
      )}
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

/** Where to go after a decision on the full page: the next thing that waits for this person, if any. */
function useNextDecision(active: boolean, id: string): { href: string; label: string } | null {
  const [next, setNext] = useState<{ href: string; label: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void fetch('/api/sidebar', { cache: 'no-store' })
      .then(async (res) => (res.ok ? sidebarSchema.safeParse(await res.json()) : null))
      .then((parsed) => {
        if (!live || parsed?.success !== true) return;
        const d = parsed.data;
        const g = d.gate2.find((x) => x.id !== id);
        const plan = d.plans[0];
        const release = d.releases[0];
        setNext(
          g !== undefined
            ? { href: `/decisions/gate2/${g.id}`, label: 'Next decision' }
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
  }, [active, id]);
  return next;
}

/**
 * `variant="inline"`: the card in the conversation and the inbox. `variant="page"`: the full decision page, laid out
 * per prototype 06 on phones (big clock, sticky footer, 56 px Deny). `body` and `asRole` come from the gate2.requested
 * event; without `asRole` the role is read from the request's gate key, which carries the same value. `audit` names
 * the asking audit (the inbox and the page); `gone` says the inbox's last refresh no longer lists it as pending.
 */
export function Gate2Card({
  gate2,
  body = null,
  asRole,
  variant = 'inline',
  viewerName = null,
  audit = null,
  gone = false,
  onClosed,
}: {
  readonly gate2: Card;
  readonly body?: string | null;
  readonly asRole?: string | null;
  readonly variant?: 'inline' | 'page';
  readonly viewerName?: string | null;
  readonly audit?: AuditContext | null;
  readonly gone?: boolean;
  /** Called once the card shows its receipt (decided here, elsewhere, or by the deadline). */
  readonly onClosed?: (id: string) => void;
}) {
  const [decided, setDecided] = useState<{ gate2: Gate2Detail; already: boolean } | null>(null);
  const [server, setServer] = useState<Gate2Detail | null>(null);
  const [checks, setChecks] = useState(0);
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
    ((clock !== null && clock.secondsLeft === 0) || (gone && !stillOpen));
  const closed = !pending || confirmedExpired;
  const role = asRole === undefined ? roleFromPathKey(gate2.pathKey) : asRole;
  const question = gate2Question(role);
  const id = gate2.id;

  // The buttons that had the focus are gone once decided: keep the keyboard on the receipt instead of the page top.
  useEffect(() => {
    if (decided !== null) receiptRef.current?.focus({ preventScroll: true });
  }, [decided]);
  useEffect(() => {
    if (closed) onClosed?.(id);
  }, [closed, onClosed, id]);

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

  const next = useNextDecision(page && closed, id);

  const done = (g: Gate2Detail, already: boolean): void => {
    setDecided({ gate2: g, already });
  };

  if (needsCheck) return <Checking gate2={current} />;

  if (closed) {
    const receipt = (
      <div ref={receiptRef} tabIndex={-1} className="rounded-[14px] focus:outline-none">
        <DecisionReceipt
          gate2={current}
          viewerName={viewerName}
          alreadyDecided={decided?.already ?? false}
          audit={page ? null : audit}
        />
      </div>
    );
    if (!page) return receipt;
    const runLink = `/runs/${gate2.runId}`;
    return (
      <div className="flex max-w-[880px] flex-col gap-4">
        <h1 className="m-0 text-[22px] font-semibold leading-[30px] text-foreground md:hidden">
          {audit?.assetName ?? 'Request during an audit'}
        </h1>
        {receipt}
        <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
          {next === null ? null : (
            <Link
              href={next.href}
              className={`inline-flex min-h-11 items-center md:min-h-0 ${LINK}`}
            >
              {next.label}
              <Icon name="right" size={14} className="ml-1" />
            </Link>
          )}
          <Link href={runLink} className={`inline-flex min-h-11 items-center md:min-h-0 ${LINK}`}>
            Open the audit
          </Link>
          <Link
            href="/decisions"
            className={`inline-flex min-h-11 items-center md:min-h-0 ${LINK}`}
          >
            All decisions
          </Link>
        </p>
      </div>
    );
  }

  // Prototypes 04 and 06 draw the clock in ink; it turns warn under 60 s and bad under 15 s.
  const ink = clock === null || clock.tone === 'normal' ? 'text-foreground!' : '';
  const created = gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt };
  const clockHead = (
    <span className="ml-auto flex items-baseline gap-1.5" role="timer" aria-live="off">
      <Countdown
        deadlineAt={gate2.deadlineAt}
        {...created}
        suffix=""
        className={`text-[19px] leading-6 ${ink}`}
      />
      <small className="text-[11.5px] text-muted-foreground">left, then it&apos;s denied</small>
    </span>
  );
  const bar = <Countdown variant="bar" deadlineAt={gate2.deadlineAt} {...created} />;
  const runLink = `/runs/${gate2.runId}`;
  const links = (
    <>
      {' '}
      ·{' '}
      <Link href={runLink} className={LINK}>
        Open the live audit
      </Link>
      {page ? null : (
        <>
          {' '}
          ·{' '}
          <Link href={`/decisions/gate2/${id}`} className={LINK}>
            Open on its own page
          </Link>
        </>
      )}
    </>
  );
  const card = (
    <section
      role="alertdialog"
      aria-label={`Your decision: ${question}`}
      data-gate2-scope=""
      className="overflow-hidden rounded-2xl border-[1.5px] border-gold-ink bg-card shadow-[0_10px_30px_rgba(138,99,16,.12)]"
    >
      <header className="flex items-center gap-2.5 border-b border-gold-line bg-gold-soft px-4 py-2">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-gold-ink">
          <Icon name="hand" size={15} />
          Your decision
        </span>
        {clockHead}
      </header>
      {bar}
      <div className="grid gap-4 px-4 pb-3.5 pt-3 md:grid-cols-[minmax(0,1fr)_220px] md:has-[[data-allowing]]:grid-cols-1">
        <div className="min-w-0">
          <h3 className="m-0 text-[15.5px] font-semibold leading-[23px] text-foreground">
            {question}
          </h3>
          {audit === null ? null : <AuditLine gate2={gate2} audit={audit} links={links} />}
          <RequestBox gate2={gate2} body={body} />
          <Chips gate2={gate2} />
          <WhyAsked text={gate2.whyOutside} />
          <ClaudeReason reason={gate2.reason} />
        </div>
        <Gate2Actions
          gate2Id={id}
          deadlineAt={gate2.deadlineAt}
          createdAt={gate2.createdAt}
          layout="column"
          autoFocus={page}
          onDecided={done}
        />
      </div>
    </section>
  );
  if (!page) return card;

  const host = hostOf(gate2.url);
  return (
    <>
      <div className="hidden max-w-[880px] flex-col gap-4 md:flex">
        {card}
        {audit === null ? (
          <p className="m-0 text-[12.5px] text-muted-foreground">
            {host} · asked by {agentName(gate2.agent)}
            {links}
          </p>
        ) : null}
      </div>

      <div
        data-gate2-scope=""
        className="-mx-4 -mb-5 -mt-5 flex min-h-[calc(100dvh-52px)] flex-col bg-surface-2 md:hidden"
      >
        <div className="h-1 [&>div]:h-1">{bar}</div>
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
            <RequestBox gate2={gate2} body={body} />
            <Chips gate2={gate2} />
          </section>
          <ClaudeReason reason={gate2.reason} phone />
          <section className="rounded-2xl border border-border bg-card px-[15px] py-[13px]">
            <span className="block text-[11.5px] text-muted-foreground">
              {audit?.assetName ?? host}
              {audit === null ? null : (
                <>
                  {' '}
                  · audit started <When iso={audit.startedAt} />
                </>
              )}{' '}
              · {agentName(gate2.agent)}
            </span>
            <p className="m-0 mt-0.5 text-[13px] leading-5 text-foreground">
              Other agents keep working while this waits.
            </p>
            <WhyAsked text={gate2.whyOutside} />
            <Link
              href={runLink}
              className="mt-2 inline-flex min-h-11 items-center text-[13px] font-medium text-gold-ink"
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
interface InboxItem {
  readonly gate2: Gate2;
  readonly body: string | null;
  readonly asRole?: string | null | undefined;
  readonly audit: AuditContext | null;
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

const INBOX_TITLE = 'Requests during a run';

/** Fresh data for the cards already shown, in their places; new requests join at the end. */
function merge(seen: readonly InboxItem[], items: readonly InboxItem[]): readonly InboxItem[] {
  const fresh = new Map(items.map((i) => [i.gate2.id, i]));
  const kept = seen.map((s) => fresh.get(s.gate2.id) ?? s);
  const known = new Set(seen.map((s) => s.gate2.id));
  return [...kept, ...items.filter((i) => !known.has(i.gate2.id))];
}

/**
 * The inbox's Gate 2 section. The server sends what is pending (soonest deadline first). Every card keeps its place
 * until the person leaves the page: decided here, elsewhere or by the deadline, it turns into its receipt where it
 * was, so the next request never slides under the cursor. Nothing takes the focus: D and A act on the card that
 * holds the focus, else the first open one (the one with the ring).
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
  if (items !== prev) {
    setPrev(items);
    setSeen(merge(seen, items));
  }
  const listed = new Set(items.map((i) => i.gate2.id));
  const open = items.filter((i) => !closed.has(i.gate2.id)).length;
  const onClosed = (id: string): void => {
    setClosed((s) => (s.has(id) ? s : new Set(s).add(id)));
  };
  if (seen.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label={INBOX_TITLE}>
      <InboxHeading
        title={INBOX_TITLE}
        term="Gate 2"
        lede="Claude wants to send something that could change data. No answer means denied."
        count={open}
      />
      <div className="flex flex-col gap-3">
        {seen.map((item) => (
          <Gate2Card
            key={item.gate2.id}
            gate2={item.gate2}
            body={item.body}
            {...(item.asRole === undefined ? {} : { asRole: item.asRole })}
            viewerName={viewerName}
            audit={item.audit}
            gone={!listed.has(item.gate2.id)}
            onClosed={onClosed}
          />
        ))}
      </div>
    </section>
  );
}

const INBOX_POLL_MS = 5000;

/** Keeps a server-rendered inbox fresh: every 5 s while the tab is visible, on return to it, and on `bw:refresh`. */
export function InboxRefresh() {
  const router = useRouter();
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'visible') router.refresh();
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
