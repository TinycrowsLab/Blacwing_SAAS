/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// The Gate 2 decision card (experience spec §6.2): one component for the live conversation, the Decisions inbox and the
// full page. Everything on it is the runner's data or a template: the question, the exact request and body from the
// gate2.requested event, the deterministic whyOutside text. Only the dashed box holds Claude's words.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { AuthorisedUnder, buttonClass, Chip, Icon, InlineMessage, Receipt, withRedactions } from './design';
import { clockLabel, Countdown, PendingButton, useCountdown } from './design-client';
import {
  announceDecided,
  DECIDED_EVENT,
  decidedHere,
  fetchGate2,
  FOOTNOTE,
  Gate2Actions,
  type Gate2Detail,
  postDecision,
  readDraft,
} from './gate2-actions';
import { pathOf } from './run-model';
import { useNow } from './use-now';
import { agentName } from '../../lib/agents';
import {
  gate2DetailSchema,
  sidebarSchema,
  type Gate2,
  type PinnedAuthorisation,
  type SidebarData,
} from '../../lib/schemas';

type Card = Gate2 | Gate2Detail;

/** Which audit asked (target name, start time, who started it): shown wherever cards from several audits sit together. */
export interface AuditContext {
  readonly assetName: string | null;
  readonly startedAt: string;
  /** The person who asked for the audit; null when it could not be read (shown as unknown, never guessed). */
  readonly requester: string | null;
  /** The viewer asked for this audit. */
  readonly mine: boolean;
  /** What the audit looks for, in a few words ("the OWASP Top 10"): tells two audits of one site apart. */
  readonly objective: string | null;
  /** Still queued, running or paused: the receipt then leads back to it. */
  readonly live: boolean;
  /** The authorisation the audit was pinned to (run.pins); absent when the run could not be read. */
  readonly authorisation?: PinnedAuthorisation | null;
}

/** "your audit" or "Avery's audit": whose audit this is, so requests from two audits never look alike. */
export const whoseAudit = (audit: Pick<AuditContext, 'mine' | 'requester'>): string =>
  audit.mine
    ? 'your audit'
    : audit.requester === null
      ? 'an audit (owner unknown)'
      : `${audit.requester}’s audit`;

/** The worker's gate key ends in " as {role}" or " as no test account" (worker hunt/scope.ts gateKey). */
export function roleFromPathKey(pathKey: string): string | null {
  const role = / as (.+)$/.exec(pathKey)?.[1];
  return role === undefined || role === 'no test account' ? null : role;
}

const CHANGES_DATA = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SIGNS_IN = /(^|[/_.-])(log-?in|sign-?in|auth|oauth|token|session|sessions)([/_.?-]|$)/i;

/** What the request is for, by its declared method and path: a sign-in is not a data change. Null for a read. */
export function intentLabel(method: string, url: string): string | null {
  if (SIGNS_IN.test(pathOf(url).split('?')[0] ?? '')) return 'Signs in';
  return CHANGES_DATA.has(method.toUpperCase()) ? 'May change data' : null;
}

export const gate2Question = (role: string | null): string =>
  `Allow Claude to send this request ${role === null ? 'without signing in' : `as ${role}`}?`;

/** The runner's whyOutside, with the authorisation's internal term shown as the label people chose it by. */
export const plainWhy = (text: string): string =>
  text.replace(/\bactive-safe\b/g, '“Probe gently”').replace(/\bpassive\b/g, '“Look, don’t touch”');

/** The path the grant is keyed on: no query (worker scope.ts gateKey). */
const grantPath = (url: string): string => pathOf(url).split('?')[0] ?? url;

const asWho = (role: string | null): string =>
  role === null ? 'sent without signing in' : `sent as ${role}`;

/**
 * What an allow really covers (the worker's grant is METHOD + path + role, for the rest of the run): every agent, any
 * body, no further question. Said before the person commits, because the card shows one body and one reason.
 */
export const grantScope = (gate2: { method: string; url: string }, role: string | null): string =>
  `Allowing covers every ${gate2.method} ${grantPath(gate2.url)} ${asWho(role)}, from any agent and with any body, until this audit ends. Claude won't ask about it again. If this becomes a finding, Blackwing sends it once more to check it.`;

/**
 * The latest closed request in the same audit for the same method, path and role: decided before this one was raised
 * (the runner asks again after a no) or while it waited (two agents asked at once). The grant is per key, so allowing
 * this one also opens what was denied there.
 */
export function earlierDecision(
  gate2: Gate2 | Gate2Detail,
  history: readonly Gate2[],
): Gate2 | null {
  const key = (g: { pathKey: string; method: string; url: string }): string =>
    g.pathKey === '' ? `${g.method} ${g.url}` : g.pathKey;
  const mine = key(gate2);
  const at = (g: Gate2): number => Date.parse(g.decidedAt ?? g.deadlineAt);
  const weight = (g: Gate2): number => (g.status === 'approved' ? 0 : g.decidedBy === null ? 2 : 1);
  return (
    history
      .filter((g) => g.id !== gate2.id && g.status !== 'pending' && key(g) === mine)
      // An allow first (it is already open), then a person's no (the one an allow would undo), then the latest.
      .sort((a, b) => weight(a) - weight(b) || at(b) - at(a))[0] ?? null
  );
}

function hostOf(url: string): string {
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
        <span className="font-medium text-slate">{gate2.method}</span> {withRedactions(pathOf(gate2.url))}
      </p>
      {body === null || body === '' ? null : (
        <>
          <p
            className={`m-0 whitespace-pre-wrap break-all text-muted-foreground ${open ? '' : 'line-clamp-4'}`}
          >
            {withRedactions(body)}
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
  const intent = intentLabel(gate2.method, gate2.url);
  if (intent === null) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      <Chip tone="gold">{intent}</Chip>
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

/** A tagged rule row: what the request hits (ABOVE CARE LEVEL, EXCLUDED PATH) and the rule it hits. */
function RuleRow({ tag, children }: { readonly tag: string; readonly children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="shrink-0 rounded-[4px] bg-warn-soft px-1.5 py-px font-mono text-[10.5px] font-semibold tracking-[0.04em] text-warn">
        {tag}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * Why this is outside the authorisation, as rule rows (deterministic: the runner's whyOutside and the pinned
 * authorisation, never Claude's words). Falls back to the runner's sentence when it does not split into a rule.
 */
function WhyAsked({
  gate2,
  auth = null,
  phone = false,
}: {
  readonly gate2: Card;
  readonly auth?: PinnedAuthorisation | null;
  readonly phone?: boolean;
}) {
  if (gate2.whyOutside === '') return null;
  const path = grantPath(gate2.url);
  const excluded = auth?.excludedPaths.find((p) => path.startsWith(p)) ?? null;
  // The runner writes "<what it is>; the authorisation covers only active-safe requests. It would be sent as …".
  const what = gate2.whyOutside.split(';')[0]?.trim() ?? '';
  const above = gate2.intrusiveness === 'state_changing' && what !== '' && what !== gate2.whyOutside.trim();
  const box = `m-0 text-[12.5px] leading-[19px] text-muted-foreground ${phone ? 'mt-1.5' : 'mt-2'}`;
  if (!above && excluded === null) return <p className={box}>{plainWhy(gate2.whyOutside)}</p>;
  return (
    <div className={box}>
      <span className="block text-[11.5px] font-medium text-foreground">Why this is outside the authorisation</span>
      <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
        {above ? (
          <RuleRow tag="ABOVE CARE LEVEL">
            {plainWhy(what)}. {auth === null ? 'The authorisation' : <span className="font-mono text-[11.5px]">{auth.saId}</span>} allows
            up to {auth?.care === null || auth?.care === undefined ? '“Probe gently”' : `“${auth.care}”`}.
          </RuleRow>
        ) : null}
        {excluded === null ? null : (
          <RuleRow tag="EXCLUDED PATH">
            <span className="font-mono text-[11.5px]">{excluded}</span> is on the paths to avoid.
          </RuleRow>
        )}
      </ul>
    </div>
  );
}

/**
 * "You denied this at 2:41 pm (Web & API specialist: …). Allowing now opens it to every agent, that one included.": the
 * card remembers, so a second ask never looks like a lost click, and an allow never silently undoes an earlier no.
 */
function Earlier({
  earlier,
  current,
  viewerName,
}: {
  readonly earlier: Gate2;
  readonly current: Card;
  readonly viewerName: string | null;
}) {
  const time = <When iso={earlier.decidedAt ?? earlier.deadlineAt} />;
  const who =
    earlier.decidedBy === null
      ? null
      : earlier.decidedBy === viewerName
        ? 'You'
        : earlier.decidedBy;
  const asked = (
    <>
      {' '}
      ({agentName(earlier.agent)}
      {earlier.reason === '' ? '' : `: “${earlier.reason}”`})
    </>
  );
  const sameAsker = earlier.agent === current.agent && earlier.reason === current.reason;
  return (
    <p className="m-0 mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-[19px] text-muted-foreground">
      <Icon name="repeat" size={13} className="mt-[3px] shrink-0" />
      <span>
        {earlier.status === 'approved' ? (
          <>
            {who ?? 'Someone'} already allowed this same method, path and role at {time}. It stays
            allowed for this run, whatever you answer here.
          </>
        ) : (
          <>
            {who === null ? (
              <>This same method, path and role was denied automatically at {time}</>
            ) : (
              <>
                {who} denied this same method, path and role at {time}
              </>
            )}
            {sameAsker ? '' : asked}.{' '}
            <span className="text-foreground">
              Allowing now opens it to every agent
              {sameAsker ? '' : ', that request included'}.
            </span>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * The decision, collapsed. A human decision is on the ledger; an automatic denial is the runner's (no ledger row).
 * `line`: one row (the inbox, for requests closed elsewhere or by the deadline), so settled requests never crowd the
 * ones still waiting.
 */
function DecisionReceipt({
  gate2,
  role,
  viewerName,
  alreadyDecided,
  line = false,
}: {
  readonly gate2: Card;
  readonly role: string | null;
  readonly viewerName: string | null;
  readonly alreadyDecided: boolean;
  readonly line?: boolean;
}) {
  const time = <When iso={gate2.decidedAt ?? gate2.deadlineAt} />;
  const request = (
    <span className="font-mono text-[12px]">
      {gate2.method} {withRedactions(pathOf(gate2.url))}
    </span>
  );
  const human =
    gate2.status === 'approved' || (gate2.status === 'denied' && gate2.decidedBy !== null);
  const who = gate2.decidedBy === null || gate2.decidedBy === viewerName ? 'you' : gate2.decidedBy;
  // `denied` without a person: the audit stopped. `expired`, or still `pending` past the deadline: nobody answered.
  const stopped = gate2.status === 'denied';
  const title = human ? (
    gate2.status === 'approved' ? (
      <>
        Allowed for this run by {who} at {time}
        {gate2.decisionReason === null ? '' : `: “${gate2.decisionReason}”`}
      </>
    ) : (
      <>
        Denied by {who} at {time}
      </>
    )
  ) : (
    <>
      Denied automatically at {time} {stopped ? '(the audit stopped)' : '(no answer)'}
    </>
  );
  if (line)
    return (
      <div
        role="status"
        className="flex min-h-11 items-center gap-2.5 rounded-[12px] border border-border bg-surface-2 px-3.5 py-2 text-[12.5px] leading-5 text-muted-foreground"
      >
        <span
          className={`flex size-4 shrink-0 items-center justify-center rounded-full ${gate2.status === 'approved' ? 'bg-ok text-white' : 'bg-text text-bg'}`}
        >
          <Icon name={gate2.status === 'approved' ? 'check' : 'x'} size={10} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground">{title}</span> · {request}
        </span>
      </div>
    );
  const detail = (consequence: ReactNode) => (
    <>
      <span className="block">{request}</span>
      <span className="block">{consequence}</span>
      {alreadyDecided ? (
        <span className="block">Already decided in another tab or by a teammate.</span>
      ) : null}
    </>
  );
  const hash = 'audit' in gate2 ? (gate2.audit?.hash ?? null) : null;
  if (human)
    return (
      <Receipt
        tone={gate2.status === 'approved' ? 'ok' : 'bad'}
        title={title}
        detail={detail(
          gate2.status === 'approved'
            ? `Claude may now send any ${gate2.method} ${grantPath(gate2.url)} ${asWho(role)}, from any agent, until the run ends.`
            : 'Not sent. Claude moves on to its next test.',
        )}
        hash={hash}
      />
    );
  // No person decided. A deadline is ledgered by the runner (gate2.expired); a stopped audit's close is in its activity.
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[14px] border border-border bg-card px-4 py-3"
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-text text-bg">
        <Icon name="x" size={12} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium leading-5 text-foreground">{title}</span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">
          {detail(
            stopped
              ? 'Not sent.'
              : 'Not sent. If Claude still needs it, it asks again in this audit. To be sure it gets tested, use “Run this audit again” on the results once this audit ends.',
          )}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {stopped
            ? 'Recorded in the audit’s activity.'
            : 'Recorded in the audit ledger as an automatic deny.'}
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
        {gate2.method} {withRedactions(pathOf(gate2.url))}
      </span>
      …
    </div>
  );
}

const PAGE_POLL_MS = 5000;
const CHECK_RETRY_MS = 2000;

interface NextStep {
  readonly href: string;
  readonly label: string;
}

/**
 * Where to go after a decision on the full page. `decision`: another request with a deadline (this audit's first), which
 * leads. `later`: a plan or a release, offered only as a quiet link, so a live audit never loses the person to triage.
 */
function useNextDecision(
  active: boolean,
  id: string,
  runId: string,
): { decision: NextStep | null; later: NextStep | null } {
  const [next, setNext] = useState<{ decision: NextStep | null; later: NextStep | null }>({
    decision: null,
    later: null,
  });
  useEffect(() => {
    if (!active) return;
    let live = true;
    void fetch('/api/sidebar', { cache: 'no-store' })
      .then(async (res) => (res.ok ? sidebarSchema.safeParse(await res.json()) : null))
      .then((parsed) => {
        if (!live || parsed?.success !== true) return;
        const d = parsed.data;
        const others = d.gate2
          .filter((x) => x.id !== id && decidedHere(x.id) === null)
          .sort((a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt));
        const same = others.find((x) => x.runId === runId);
        const g = same ?? others[0];
        const plan = d.plans[0];
        const release = d.releases[0];
        setNext({
          decision:
            g === undefined
              ? null
              : {
                  href: `/decisions/gate2/${g.id}`,
                  label:
                    same === undefined
                      ? 'Next request, from another audit'
                      : 'Next request in this audit',
                },
          later:
            plan !== undefined
              ? { href: `/audits/${plan.id}`, label: 'A plan waits for your approval' }
              : release !== undefined
                ? { href: `/findings/${release.id}`, label: 'A finding waits for your release' }
                : null,
        });
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
          {clock?.totalSeconds === null || clock === null ? null : (
            <span className="text-[12px] text-muted-foreground">of {clockLabel(clock.totalSeconds)} allowed</span>
          )}
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
              {audit.mine ? 'Yours' : audit.requester === null ? 'Owner unknown' : audit.requester.charAt(0).toUpperCase() + audit.requester.slice(1)},{' '}
              <When iso={audit.startedAt} />
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Asked by</dt>
        <dd className="m-0 text-right text-foreground">{agentName(gate2.agent)}</dd>
      </dl>
      {audit?.authorisation === null || audit?.authorisation === undefined ? null : (
        <div className="w-full border-t border-border pt-4">
          <AuthorisedUnder auth={audit.authorisation} variant="card" />
        </div>
      )}
      <Link href={runLink} className={`self-start text-[13px] ${LINK}`}>
        Open the live audit
      </Link>
    </aside>
  );
}

/** A request waiting in the inbox, folded to one line so only one question is open at a time. */
function CompactRow({ gate2, onExpand }: { readonly gate2: Card; readonly onExpand: () => void }) {
  const created = gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt };
  const clock = useCountdown(gate2.deadlineAt, gate2.createdAt);
  // The folded row shows urgency too (not only the open card): the frame turns warn, then bad in the last minute.
  const frame =
    clock?.tone === 'bad'
      ? 'border-bad shadow-[0_0_0_1px_var(--bad)]'
      : clock?.tone === 'warn'
        ? 'border-warn shadow-[0_0_0_1px_var(--warn)]'
        : 'border-gold-line';
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={onExpand}
      className={`flex min-h-14 w-full items-center gap-3 rounded-[14px] border bg-card px-4 py-2.5 text-left hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${frame}`}
    >
      <Icon name="hand" size={15} className="shrink-0 text-gold-ink" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[12.5px] text-foreground">
          <span className="font-medium text-slate">{gate2.method}</span> {withRedactions(pathOf(gate2.url))}
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

const followClass = (lead: boolean): string =>
  lead
    ? buttonClass('primary', 'h-11 w-full justify-center rounded-[12px] md:w-auto')
    : buttonClass('secondary', 'h-11 w-full justify-center rounded-[12px] md:w-auto');

/**
 * The full page once decided: the receipt, what was asked (so the screen still says what the answer was about) and the
 * next step. Another request with a deadline leads; else, while the audit runs, the way back to it; a plan or a release
 * is only a quiet link, so a live audit never loses the person to triage.
 */
function PageReceipt({
  gate2,
  receipt,
  question,
  body,
  audit,
  next,
}: {
  readonly gate2: Card;
  readonly receipt: ReactNode;
  readonly question: string;
  readonly body: string | null;
  readonly audit: AuditContext | null;
  readonly next: { decision: NextStep | null; later: NextStep | null };
}) {
  const runLink = `/runs/${gate2.runId}`;
  const live = audit?.live ?? true;
  return (
    <div className="flex max-w-[880px] flex-col gap-4 max-md:-mx-4 max-md:-mt-5 max-md:min-h-[calc(100dvh-52px)] max-md:px-4 max-md:pb-6 max-md:pt-5">
      <h1 className="m-0 text-[22px] font-semibold leading-[30px] text-foreground md:hidden">
        {audit?.assetName ?? 'Request during an audit'}
      </h1>
      {receipt}
      <section className="rounded-2xl border border-border bg-card px-4 py-3.5">
        <span className="block text-[11.5px] text-muted-foreground">
          What you were asked · {agentName(gate2.agent)}
        </span>
        <h2 className="m-0 mt-0.5 text-[15px] font-semibold leading-[22px] text-foreground">
          {question}
        </h2>
        <RequestBox gate2={gate2} body={body} />
        <ClaudeReason reason={gate2.reason} />
      </section>
      <nav
        aria-label="What next"
        className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3"
      >
        {next.decision === null ? null : (
          <Link href={next.decision.href} className={followClass(true)}>
            {next.decision.label}
            <Icon name="right" size={15} className="ml-1" />
          </Link>
        )}
        <Link href={runLink} className={followClass(next.decision === null)}>
          {live ? 'Back to the live audit' : 'Open the audit'}
        </Link>
        <Link
          href="/decisions"
          className={`inline-flex min-h-11 items-center justify-center text-[13px] md:ml-2 ${LINK}`}
        >
          All decisions
        </Link>
        {next.later === null || live ? null : (
          <Link
            href={next.later.href}
            className={`inline-flex min-h-11 items-center justify-center text-[13px] md:ml-auto ${LINK}`}
          >
            {next.later.label}
          </Link>
        )}
      </nav>
    </div>
  );
}

/**
 * `variant="inline"`: the card in the conversation and the inbox. `variant="page"`: the full decision page (a deadline
 * panel beside the card on desktop; prototype 06 on phones: big clock, sticky footer, 56 px Deny). `body` and `asRole`
 * come from the gate2.requested event; without `asRole` the role is read from the request's gate key, which carries
 * the same value. `audit` names the asking audit (the page); `history` is the audit's other requests, so a second ask
 * for the same method, path and role says what was decided before; `gone` says the inbox's last refresh no longer
 * lists it as pending; `compact` folds a waiting request to one line until `onExpand`; `line` shows a request closed
 * elsewhere as a one-line receipt; `autoFocus` puts the keyboard on Deny once (the page does by default).
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
  line = false,
  footnote = true,
  autoFocus,
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
  readonly line?: boolean;
  readonly footnote?: boolean;
  readonly autoFocus?: boolean;
  readonly onExpand?: () => void;
  /** Called once the card shows its receipt (decided here, elsewhere, or by the deadline). */
  readonly onClosed?: (id: string) => void;
}) {
  // Decided in this tab already (another page, then Back or the sidebar link): the receipt at once, never the question.
  const [decided, setDecided] = useState<{ gate2: Gate2Detail; already: boolean } | null>(() => {
    const here = decidedHere(gate2.id);
    return here === null ? null : { gate2: here, already: false };
  });
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
  // Decided by a click on this card (not restored from the tab's memory): the receipt takes the keyboard.
  const [clicked, setClicked] = useState(false);

  // The buttons that had the focus are gone once decided: keep the keyboard on the receipt instead of the page top.
  useEffect(() => {
    if (clicked) receiptRef.current?.focus({ preventScroll: true });
  }, [clicked]);
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
    setClicked(true);
  };

  if (needsCheck) return <Checking gate2={current} />;

  const runLink = `/runs/${gate2.runId}`;
  if (closed) {
    const receipt = (
      <div ref={receiptRef} tabIndex={-1} className="rounded-[14px] focus:outline-none">
        <DecisionReceipt
          gate2={current}
          role={role}
          viewerName={viewerName}
          alreadyDecided={decided?.already ?? false}
          line={line && !clicked}
        />
      </div>
    );
    if (!page) return receipt;
    return (
      <PageReceipt
        gate2={gate2}
        receipt={receipt}
        question={question}
        body={body}
        audit={audit}
        next={next}
      />
    );
  }

  if (compact && onExpand !== undefined) return <CompactRow gate2={gate2} onExpand={onExpand} />;

  // Prototypes 04 and 06 draw the clock in ink; it turns warn, then bad (pulsing) in the last minute.
  const ink = clock === null || clock.tone === 'normal' ? 'text-foreground!' : '';
  const created = gate2.createdAt === undefined ? {} : { createdAt: gate2.createdAt };
  const bar = <Countdown variant="bar" deadlineAt={gate2.deadlineAt} {...created} />;
  const scope = grantScope(gate2, role);
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
      {/* The action column keeps its width while Allow is open, so Deny never moves or changes weight. */}
      <div className="grid gap-4 px-4 pb-3.5 pt-3 md:grid-cols-[minmax(0,1fr)_236px]">
        <div className="min-w-0">
          <h3 className="m-0 text-[15.5px] font-semibold leading-[23px] text-foreground">
            {question}
          </h3>
          {page ? null : (
            <p className="m-0 mt-0.5 text-[12.5px] leading-5 text-muted-foreground">
              Asked by {agentName(gate2.agent)}
            </p>
          )}
          {earlier === null ? null : (
            <Earlier earlier={earlier} current={gate2} viewerName={viewerName} />
          )}
          <RequestBox gate2={gate2} body={body} />
          <Chips gate2={gate2} />
          <WhyAsked gate2={gate2} auth={audit?.authorisation ?? null} />
          <ClaudeReason reason={gate2.reason} />
        </div>
        <Gate2Actions
          gate2Id={id}
          deadlineAt={gate2.deadlineAt}
          createdAt={gate2.createdAt}
          layout="column"
          autoFocus={autoFocus ?? page}
          footnote={footnote}
          scope={scope}
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
        className="-mx-4 -mb-5 -mt-5 flex min-h-[calc(100dvh-52px)] flex-col bg-bg md:hidden"
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
            {earlier === null ? null : (
              <Earlier earlier={earlier} current={gate2} viewerName={viewerName} />
            )}
            <RequestBox gate2={gate2} body={body} />
            <Chips gate2={gate2} />
            <WhyAsked gate2={gate2} auth={audit?.authorisation ?? null} phone />
          </section>
          <ClaudeReason reason={gate2.reason} phone />
          <section className="rounded-2xl border border-border bg-card px-[15px] py-[13px]">
            <span className="block text-[11.5px] text-muted-foreground">
              {audit?.assetName ?? host}
              {audit === null ? null : <> · {whoseAudit(audit)}</>} · {agentName(gate2.agent)}
            </span>
            <Link
              href={runLink}
              className="inline-flex min-h-11 items-center text-[13px] font-medium text-gold-ink"
            >
              Open the live audit
            </Link>
          </section>
          {audit?.authorisation === null || audit?.authorisation === undefined ? null : (
            <section className="rounded-2xl border border-border bg-card px-[15px] py-[13px]">
              <AuthorisedUnder auth={audit.authorisation} variant="card" />
            </section>
          )}
        </div>
        <div className="sticky bottom-0 border-t border-border bg-bg px-4 pb-[22px] pt-3">
          <Gate2Actions
            gate2Id={id}
            deadlineAt={gate2.deadlineAt}
            createdAt={gate2.createdAt}
            layout="sheet"
            autoFocus={autoFocus ?? page}
            scope={scope}
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

/** Fresh data for the cards already shown; new requests join. Settled ones stay (as receipts) until the person leaves. */
function merge(seen: readonly InboxItem[], items: readonly InboxItem[]): readonly InboxItem[] {
  const fresh = new Map(items.map((i) => [i.gate2.id, i]));
  const kept = seen.map((s) => fresh.get(s.gate2.id) ?? s);
  const known = new Set(seen.map((s) => s.gate2.id));
  return [...kept, ...items.filter((i) => !known.has(i.gate2.id))];
}

/**
 * The inbox's order, recomputed when a new request arrives (never on a decision or a deadline, so nothing slides under
 * the cursor): audits by their soonest open deadline; in each, open requests soonest first, then the
 * settled ones as receipts. Exported for the unit test.
 */
export function inboxOrder(
  seen: readonly InboxItem[],
  isOpen: (item: InboxItem) => boolean,
): readonly (readonly InboxItem[])[] {
  const deadline = (i: InboxItem): number => Date.parse(i.gate2.deadlineAt);
  const groups = new Map<string, InboxItem[]>();
  for (const item of seen) {
    const g = groups.get(item.gate2.runId);
    if (g === undefined) groups.set(item.gate2.runId, [item]);
    else g.push(item);
  }
  const rank = (i: InboxItem): number => (isOpen(i) ? deadline(i) : Number.POSITIVE_INFINITY);
  const sorted = [...groups.values()].map((g) =>
    [...g].sort((a, b) => rank(a) - rank(b) || deadline(a) - deadline(b)),
  );
  const soonest = (g: readonly InboxItem[]): number =>
    g[0] === undefined ? Number.POSITIVE_INFINITY : rank(g[0]);
  return sorted.sort((a, b) => soonest(a) - soonest(b));
}

/** The short id that tells two audits of the same site, started the same minute, apart. */
const SHORT_ID = 6;

/**
 * One audit's header: which site, what it looks for, whose audit and when it started; the live audit; "Deny all" when
 * several wait. Deny all asks once more in place, so a stray tap on a phone never denies a batch.
 */
function AuditHeader({
  item,
  openIds,
  twin,
}: {
  readonly item: InboxItem;
  readonly openIds: readonly string[];
  /** Another audit in the list reads the same: show the run's short id. */
  readonly twin: boolean;
}) {
  const [failed, setFailed] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const { audit } = item;
  const denyAll = async (): Promise<void> => {
    setFailed(0);
    const results = await Promise.all(openIds.map((id) => postDecision(id, 'deny', '')));
    for (const r of results) if (r.ok) announceDecided(r.gate2);
    setFailed(results.filter((r) => !r.ok).length);
    setConfirming(false);
    window.dispatchEvent(new Event('bw:refresh'));
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-x-3 gap-y-1 sm:flex-row sm:items-center">
        <p className="m-0 min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground">
            {audit?.assetName ?? hostOf(item.gate2.url)}
          </span>
          {audit === null ? null : (
            <>
              {audit.objective === null ? null : <> · {audit.objective}</>} · {whoseAudit(audit)},
              started <When iso={audit.startedAt} />
            </>
          )}
          {twin ? (
            <span className="font-mono text-[11.5px]">
              {' '}
              · #{item.gate2.runId.slice(0, SHORT_ID)}
            </span>
          ) : null}
        </p>
        <div className="flex items-center gap-3">
          <Link
            href={`/runs/${item.gate2.runId}`}
            className={`inline-flex min-h-11 items-center text-[12.5px] sm:min-h-0 ${LINK}`}
          >
            Open the live audit
          </Link>
          {openIds.length < 2 ? null : confirming ? (
            <span className="flex items-center gap-1.5 max-sm:ml-auto">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                }}
                className={buttonClass('ghost', 'h-8 px-2.5 text-[12.5px] max-sm:h-11')}
              >
                Keep them
              </button>
              <PendingButton
                variant="deny"
                pendingLabel="Denying…"
                onAction={denyAll}
                className="h-8 px-3 text-[12.5px] max-sm:h-11"
              >
                Deny {openIds.length} requests
              </PendingButton>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
              }}
              className={buttonClass(
                'ghost',
                'h-8 px-2.5 text-[12.5px] max-sm:ml-auto max-sm:h-11',
              )}
            >
              Deny all {openIds.length}…
            </button>
          )}
        </div>
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

const auditLabel = (i: InboxItem): string =>
  `${i.audit?.assetName ?? hostOf(i.gate2.url)}|${i.audit?.objective ?? ''}|${i.audit?.mine === true ? 'me' : (i.audit?.requester ?? '')}|${i.audit?.startedAt.slice(0, 16) ?? ''}`;

/**
 * The inbox's Gate 2 section, grouped by audit. Only the soonest open request is unfolded (plus any the person opens),
 * like one question at a time, and Deny has the keyboard when the page opens; the footnote shows once. A request
 * decided here keeps its full receipt in place; one closed elsewhere or by the deadline is a one-line receipt. Settled
 * ones sink below the open ones when a new request arrives. D and A act on the open card in view (the one with the ring).
 */
export function Gate2Inbox({
  items,
  viewerName,
  more = 0,
}: {
  readonly items: readonly InboxItem[];
  readonly viewerName: string;
  /** Open requests beyond the listed ones (the list is capped; the count is exact). */
  readonly more?: number;
}) {
  const [seen, setSeen] = useState<readonly InboxItem[]>(items);
  const [prev, setPrev] = useState(items);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const listed = new Set(items.map((i) => i.gate2.id));
  const isOpen = (i: InboxItem): boolean => !closed.has(i.gate2.id) && listed.has(i.gate2.id);
  const ids = (groups: readonly (readonly InboxItem[])[]): readonly (readonly string[])[] =>
    groups.map((g) => g.map((i) => i.gate2.id));
  const [order, setOrder] = useState(() =>
    ids(inboxOrder(items, (i) => decidedHere(i.gate2.id) === null)),
  );
  if (items !== prev) {
    const merged = merge(seen, items);
    setPrev(items);
    setSeen(merged);
    // Re-sorted only when a new request arrives: a decision or a deadline never moves a card under the cursor.
    const known = new Set(seen.map((i) => i.gate2.id));
    if (items.some((i) => !known.has(i.gate2.id))) setOrder(ids(inboxOrder(merged, isOpen)));
  }
  const byId = new Map(seen.map((i) => [i.gate2.id, i]));
  const groups = order.map((g) => g.flatMap((id) => byId.get(id) ?? []));
  // A request with a reason typed before a reload opens again, so the draft is where the person left it.
  useEffect(() => {
    const drafts = seen.filter((i) => readDraft(i.gate2.id) !== '').map((i) => i.gate2.id);
    if (drafts.length > 0) setExpanded((s) => new Set([...s, ...drafts]));
    // Once, after mount: storage is the browser's.
  }, []);
  const open = items.filter(
    (i) => !closed.has(i.gate2.id) && decidedHere(i.gate2.id) === null,
  ).length;
  const onClosed = (id: string): void => {
    setClosed((s) => (s.has(id) ? s : new Set(s).add(id)));
  };
  // The one unfolded card is the open request with the soonest deadline (the server lists them soonest first), wherever
  // it sits, so the most urgent request is never the one left folded.
  const first = items.find((i) => isOpen(i) && decidedHere(i.gate2.id) === null)?.gate2.id;
  // Deny takes the keyboard once, on the card unfolded when the page opened, never on one that unfolds after a decision.
  const focusFirst = useRef(first);
  if (seen.length === 0) return null;
  const labels = groups.map((g) => (g[0] === undefined ? '' : auditLabel(g[0])));
  return (
    <section className="flex flex-col gap-3" aria-label={INBOX_TITLE}>
      <InboxHeading
        title={INBOX_TITLE}
        term="Gate 2"
        lede="Claude wants to send something that could change data. No answer means denied."
        count={open + more}
      />
      {groups.map((group, n) => {
        const head = group[0];
        if (head === undefined) return null;
        return (
          <div key={head.gate2.runId} className="flex flex-col gap-2">
            <AuditHeader
              item={head}
              openIds={group.filter((i) => isOpen(i)).map((i) => i.gate2.id)}
              twin={labels.filter((l) => l === labels[n]).length > 1}
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
                  line
                  footnote={false}
                  autoFocus={id === focusFirst.current}
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
      {more === 0 ? null : (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          And {more.toLocaleString()} more {more === 1 ? 'request' : 'requests'}, listed here as these
          are decided.
        </p>
      )}
      {open === 0 ? null : (
        <p className="m-0 text-[12px] leading-[18px] text-muted-foreground">{FOOTNOTE}</p>
      )}
    </section>
  );
}

const INBOX_POLL_MS = 5000;
// shortcut: plain fallback refresh for what the sidebar slice does not carry (kept-back findings); a server push
// replaces both polls once the API streams workspace events. Long, because each refresh reads every asking audit.
const INBOX_FULL_MS = 120_000;

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
export function InboxRefresh({
  waiting,
  incomplete = false,
}: {
  readonly waiting: Waiting;
  /** A read behind the page failed: refresh on the next poll even if nothing changed. */
  readonly incomplete?: boolean;
}) {
  const router = useRouter();
  const current = useRef(signature(waiting));
  const now = signature(waiting);
  const retry = useRef(incomplete);
  useEffect(() => {
    current.current = now;
    retry.current = incomplete;
  }, [now, incomplete]);
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
          // A failed read is retried once a poll has passed (never on the mount check itself).
          const again = retry.current && Date.now() - last >= INBOX_POLL_MS / 2;
          if (changed || again || Date.now() - last >= INBOX_FULL_MS) {
            last = Date.now();
            retry.current = false;
            router.refresh();
          }
        })
        .catch(() => null)
        .finally(() => {
          busy = false;
        });
    };
    // Once on mount too, and on Back/Forward: a page restored from the router cache may predate a decision made on
    // another page, so it checks at once instead of at the next 5 s tick.
    tick();
    const timer = window.setInterval(tick, INBOX_POLL_MS);
    window.addEventListener('bw:refresh', tick);
    window.addEventListener('popstate', tick);
    window.addEventListener('pageshow', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('bw:refresh', tick);
      window.removeEventListener('popstate', tick);
      window.removeEventListener('pageshow', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router]);
  return null;
}
