/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// The Gate 2 decision card (experience spec §6.2): one component for the live conversation, the Decisions inbox and the
// full page. Everything on it is the runner's data or a template: the question, the exact request and body from the
// gate2.requested event, the deterministic whyOutside text. Only the dashed box holds Claude's words.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Chip, Icon, Receipt } from './design';
import { Countdown, useCountdown } from './design-client';
import { Gate2Actions, type Gate2Detail } from './gate2-actions';
import { pathOf } from './run-model';
import { agentName } from '../../lib/agents';

import type { Gate2 } from '../../lib/schemas';

type Card = Gate2 | Gate2Detail;

/** The worker's gate key ends in " as {role}" or " as no test account" (worker hunt/scope.ts gateKey). */
export function roleFromPathKey(pathKey: string): string | null {
  const role = / as (.+)$/.exec(pathKey)?.[1];
  return role === undefined || role === 'no test account' ? null : role;
}

export const gate2Question = (role: string | null): string =>
  `Allow Claude to send this request ${role === null ? 'without signing in' : `as ${role}`}?`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const timeOf = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

const CHANGES_DATA = new Set(['POST', 'PUT', 'PATCH']);
// shortcut: the body is clamped by length, not by measured lines; measure once bodies get long and structured.
const BODY_CLAMP_CHARS = 240;

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
      {text}
    </p>
  );
}

/** The decision, collapsed. A human decision is on the ledger; an automatic denial is the runner's (no ledger row). */
function DecisionReceipt({
  gate2,
  expiredLocally,
  viewerName,
}: {
  readonly gate2: Card;
  readonly expiredLocally: boolean;
  readonly viewerName: string | null;
}) {
  const request = (
    <span className="font-mono text-[12px]">
      {gate2.method} {pathOf(gate2.url)}
    </span>
  );
  const at = gate2.decidedAt ?? gate2.deadlineAt;
  const time = <time suppressHydrationWarning>{timeOf(at)}</time>;
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
        detail={request}
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
        detail={request}
        hash={hash}
      />
    );
  }
  const stopped = gate2.status === 'denied' && !expiredLocally;
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
        <span className="text-[12.5px] leading-5 text-muted-foreground">{request}</span>
        <span className="text-[11.5px] text-muted-foreground">
          Not sent. Claude moves on to its next test.
        </span>
      </span>
    </div>
  );
}

/**
 * `variant="inline"`: the card in the conversation and the inbox. `variant="page"`: the full decision page, laid out
 * per prototype 06 on phones (big clock, sticky footer, 56 px Deny). `body` and `asRole` come from the gate2.requested
 * event; without `asRole` the role is read from the request's gate key, which carries the same value.
 */
export function Gate2Card({
  gate2,
  body = null,
  asRole,
  variant = 'inline',
  viewerName = null,
  onDecided,
}: {
  readonly gate2: Card;
  readonly body?: string | null;
  readonly asRole?: string | null;
  readonly variant?: 'inline' | 'page';
  readonly viewerName?: string | null;
  readonly onDecided?: (gate2: Gate2Detail) => void;
}) {
  const [decided, setDecided] = useState<Gate2Detail | null>(null);
  const current: Card = decided ?? gate2;
  const clock = useCountdown(gate2.deadlineAt, gate2.createdAt);
  const expiredLocally = current.status === 'pending' && clock !== null && clock.secondsLeft === 0;
  const role = asRole === undefined ? roleFromPathKey(gate2.pathKey) : asRole;
  const question = gate2Question(role);
  const done = (g: Gate2Detail): void => {
    setDecided(g);
    onDecided?.(g);
  };

  if (current.status !== 'pending' || expiredLocally) {
    const receipt = (
      <DecisionReceipt gate2={current} expiredLocally={expiredLocally} viewerName={viewerName} />
    );
    if (variant === 'inline') return receipt;
    return (
      <div className="flex max-w-[760px] flex-col gap-4">
        <h1 className="m-0 text-[22px] font-semibold leading-[30px] text-foreground md:hidden">
          Your decision
        </h1>
        {receipt}
        <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-[13px] font-medium">
          <Link
            href={`/runs/${gate2.runId}`}
            className="inline-flex min-h-11 items-center text-gold-ink hover:underline md:min-h-0"
          >
            Open the audit
          </Link>
          <Link
            href="/decisions"
            className="inline-flex min-h-11 items-center text-gold-ink hover:underline md:min-h-0"
          >
            All decisions
          </Link>
        </p>
      </div>
    );
  }

  const clockHead = (
    <span className="ml-auto flex items-baseline gap-1.5" role="timer" aria-live="off">
      <Countdown
        deadlineAt={gate2.deadlineAt}
        {...(gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt })}
        suffix=""
        className="text-[19px] leading-6"
      />
      <small className="text-[11.5px] text-muted-foreground">left, then it&apos;s denied</small>
    </span>
  );
  const bar = (
    <Countdown
      variant="bar"
      deadlineAt={gate2.deadlineAt}
      {...(gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt })}
    />
  );
  const card = (
    <section
      role="alertdialog"
      aria-label={`Your decision: ${question}`}
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
      <div className="grid gap-4 px-4 pb-3.5 pt-3 md:grid-cols-[minmax(0,1fr)_220px]">
        <div className="min-w-0">
          <h3 className="m-0 text-[15.5px] font-semibold leading-[23px] text-foreground">
            {question}
          </h3>
          <RequestBox gate2={gate2} body={body} />
          <Chips gate2={gate2} />
          <WhyAsked text={gate2.whyOutside} />
          <ClaudeReason reason={gate2.reason} />
        </div>
        <Gate2Actions
          gate2Id={gate2.id}
          deadlineAt={gate2.deadlineAt}
          createdAt={gate2.createdAt}
          layout="column"
          focusDeny={variant === 'page' ? 'always' : 'if-idle'}
          onDecided={done}
        />
      </div>
    </section>
  );
  if (variant === 'inline') return card;

  const host = hostOf(gate2.url);
  return (
    <>
      <div className="hidden max-w-[880px] flex-col gap-4 md:flex">
        {card}
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {host} · asked by {agentName(gate2.agent)}{' '}
          <span className="font-mono">{gate2.agent}</span> ·{' '}
          <Link href={`/runs/${gate2.runId}`} className="font-medium text-gold-ink hover:underline">
            Open the live audit
          </Link>
        </p>
      </div>

      <div className="-mx-4 -mb-5 -mt-5 flex min-h-[calc(100dvh-52px)] flex-col md:hidden">
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
          <Countdown
            variant="big"
            deadlineAt={gate2.deadlineAt}
            {...(gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt })}
          />
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
              {host} · {agentName(gate2.agent)}
            </span>
            <p className="m-0 mt-0.5 text-[13px] leading-5 text-foreground">
              Other agents keep working while this waits.
            </p>
            <WhyAsked text={gate2.whyOutside} />
            <Link
              href={`/runs/${gate2.runId}`}
              className="mt-2 inline-flex min-h-11 items-center text-[13px] font-medium text-gold-ink"
            >
              Open the live audit
            </Link>
          </section>
        </div>
        <div className="sticky bottom-0 border-t border-border bg-bg px-4 pb-[22px] pt-3">
          <Gate2Actions
            gate2Id={gate2.id}
            deadlineAt={gate2.deadlineAt}
            createdAt={gate2.createdAt}
            layout="sheet"
            focusDeny="always"
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
}

/**
 * The inbox's Gate 2 list. The server sends what is pending (soonest deadline first); a request decided here stays on
 * screen as its receipt after the refresh drops it, so the person sees what they just did.
 */
export function Gate2Inbox({
  items,
  viewerName,
}: {
  readonly items: readonly InboxItem[];
  readonly viewerName: string;
}) {
  const [kept, setKept] = useState<readonly InboxItem[]>([]);
  const shown = [...items, ...kept.filter((k) => !items.some((i) => i.gate2.id === k.gate2.id))];
  return (
    <div className="flex flex-col gap-3">
      {shown.map((item) => (
        <Gate2Card
          key={item.gate2.id}
          gate2={item.gate2}
          body={item.body}
          {...(item.asRole === undefined ? {} : { asRole: item.asRole })}
          viewerName={viewerName}
          onDecided={(g) => {
            setKept((k) => [...k, { ...item, gate2: g }]);
          }}
        />
      ))}
    </div>
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
