'use client';

// The order (experience spec §3.3): four short questions on one client route. Steps change with replaceState (no
// server round trip), answered questions collapse into receipts, the ticket fills in, and the draft is kept on this
// device. Enter continues, Esc goes back, number keys pick an option, and focus lands on each question's H1.
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { AskField, findKnown, useNormalized } from './ask-field';
import { FocusPicker } from './focus-picker';
import {
  BROAD,
  CARE,
  type Care,
  composeObjective,
  FOCUS_CHIPS,
  type FocusKey,
  isVerified,
  RECOMMEND_PILL,
  recommendedCare,
  recommendedProof,
  refreshSidebar,
  toggleFocus,
  typing,
} from './shared';
import { Ticket, TicketPill, type TicketDetail, type TicketLine } from './ticket';
import { attest, type ProofMethod, VerifyOwnership } from './verify-ownership';
import { createAuditAction, ensureTargetAction } from '../../../app/(console)/audits/actions';
import { readDrafts, removeDraft, saveDraft } from '../../../lib/drafts';
import { normalizeTarget, type TargetResult } from '../../../lib/normalize';
import { limitsPhrase, usd } from '../../../lib/plan-text';
import { buttonClass, Icon, InlineMessage, OptionCard } from '../design';
import { PendingButton } from '../design-client';

import type { Asset } from '../../../lib/schemas';

/** The four questions, by name (spec §3.3). */
const Q = { site: 1, proof: 2, focus: 3, care: 4 } as const;
const QUESTIONS = Q.care;
const STEPS = [Q.site, Q.proof, Q.focus, Q.care] as const;
const DRAFT_DEBOUNCE_MS = 300;
const FOCUS_KEYS = FOCUS_CHIPS.map((c) => c.key);

type OkTarget = Extract<TargetResult, { ok: true }>;

export interface Limits {
  readonly minutes: number;
  readonly requests: number;
  readonly costUsd: number;
}

/** Longest note carried in the address (the stored draft keeps the whole note). */
const CARRIED_TEXT_MAX = 600;
const carriedAnswers = (a: {
  readonly focus: readonly FocusKey[];
  readonly text: string;
  readonly care: Care | null;
  readonly method: ProofMethod;
}): Record<string, unknown> => ({ ...a, text: a.text.slice(0, CARRIED_TEXT_MAX) });
/** The answers carried in this page's address, if any. */
function answersFromUrl(): Record<string, unknown> | undefined {
  try {
    const raw = new URLSearchParams(window.location.search).get('a');
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const answersSchema = z
  .object({
    focus: z.array(z.enum(FOCUS_KEYS as [FocusKey, ...FocusKey[]])),
    text: z.string(),
    care: z.enum(['passive', 'active_safe']).nullable(),
    method: z.enum(['file', 'attest']),
  })
  .partial();

const okTarget = (raw: string | null): OkTarget | null => {
  if (raw === null) return null;
  const r = normalizeTarget(raw);
  return r.ok ? r : null;
};

/** Labels up to this length never break inside (not even at a hyphen); a longer one may, so it never overflows. */
const NOWRAP_LABEL = 30;

/**
 * A host in a sentence. A short one never wraps ("127.0.0.1:3001" stays whole, with the punctuation after it); a long
 * one wraps after its dots and colon, never mid-label.
 */
function Host({ text, after = '' }: { readonly text: string; readonly after?: string }) {
  if (text.length <= NOWRAP_LABEL) return <span className="whitespace-nowrap">{`${text}${after}`}</span>;
  return (
    <span className="[overflow-wrap:anywhere]">
      {text.split(/(?<=[.:])/).map((part, i) => (
        <Fragment key={i}>
          {i === 0 ? null : <wbr />}
          {part.length <= NOWRAP_LABEL ? <span className="whitespace-nowrap">{part}</span> : part}
        </Fragment>
      ))}
      {after}
    </span>
  );
}

function Receipt({
  label,
  value,
  onChange,
  warn = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly onChange: () => void;
  /** The answer cannot be used (a refused address): a warning mark instead of the green check. */
  readonly warn?: boolean;
}) {
  return (
    <div className="hidden min-h-11 items-center gap-3 rounded-[12px] border border-border bg-card px-4 py-2 md:flex">
      <span
        className={`flex size-[18px] shrink-0 items-center justify-center rounded-full ${warn ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`}
      >
        <Icon name={warn ? 'warn' : 'check'} size={11} />
      </span>
      <span className="shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{value}</span>
      <button
        type="button"
        onClick={onChange}
        className="shrink-0 rounded-md px-1.5 py-1 text-[13px] font-medium text-gold-ink hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
      >
        Change
      </button>
    </div>
  );
}

export function Order({
  initialTarget,
  initialStep,
  draftId,
  restoreDraft,
  assets,
  viewerName,
  limits,
}: {
  readonly initialTarget: string | null;
  readonly initialStep: number;
  readonly draftId: string;
  /** True when the sidebar's draft link brought the person here: its answers come back. */
  readonly restoreDraft: boolean;
  readonly assets: readonly Asset[];
  readonly viewerName: string;
  /** The suggested limits preset from the workspace; null when the workspace settings did not load. */
  readonly limits: Limits | null;
}) {
  const router = useRouter();
  const first = okTarget(initialTarget);
  const firstAsset = first === null ? null : (findKnown(assets, first.origin) ?? null);
  const startStep =
    first === null
      ? 1
      : firstAsset !== null && isVerified(firstAsset)
        ? Math.max(Q.focus, Math.min(QUESTIONS, initialStep))
        : 2;

  const [step, setStep] = useState(startStep);
  const [text, setText] = useState(initialTarget ?? '');
  const [showError, setShowError] = useState(false);
  const [target, setTarget] = useState<OkTarget | null>(first);
  const [asset, setAsset] = useState<Asset | null>(firstAsset);
  const [method, setMethod] = useState<ProofMethod>(first === null ? 'file' : recommendedProof(first.host));
  const [attested, setAttested] = useState(false);
  const [focus, setFocus] = useState<FocusKey[]>([BROAD]);
  const [focusText, setFocusText] = useState('');
  const [care, setCare] = useState<Care | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The API refused the address outright (its own console, metadata, an unlisted private host): no proof can help. */
  const [refused, setRefused] = useState<{ readonly origin: string; readonly message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [inText, setInText] = useState(false);
  /** Bumped by Try again when registering the site for question 2 failed: the registration runs again. */
  const [attempt, setAttempt] = useState(0);
  /** Set once the plan is created: no draft is saved after that (a pending debounce would leave a ghost draft). */
  const submitted = useRef(false);
  const h1 = useRef<HTMLHeadingElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const live = useNormalized(text);

  const chosenCare: Care = care ?? (target === null ? 'passive' : recommendedCare(target.host));

  // This order's draft brings its answers and its question back (this device only): from the sidebar's draft link, and
  // on browser Back then Forward, where the router cache may replay the page as it was first opened (question 2).
  // Draft ids are random per order, so a draft found here is always this order's own.
  const restored = useRef(false);
  useEffect(() => {
    // Once, on mount: later changes are the person's own.
    if (restored.current) return;
    restored.current = true;
    const stored = readDrafts().find((x) => x.id === draftId);
    // Answers also travel in the page address, so a draft opened on another device or in a fresh browser still has them.
    const carried = stored === undefined && restoreDraft ? answersFromUrl() : undefined;
    const d =
      stored ??
      (carried === undefined || first === null
        ? undefined
        : { id: draftId, origin: first.origin, host: first.host, step: initialStep, answers: carried, savedAt: '' });
    if (d === undefined || (!restoreDraft && d.origin !== first?.origin)) return;
    const a = answersSchema.safeParse(d.answers);
    if (!a.success) return;
    if (a.data.focus !== undefined && a.data.focus.length > 0) setFocus(a.data.focus);
    if (a.data.text !== undefined) setFocusText(a.data.text);
    if (a.data.care !== undefined) setCare(a.data.care);
    if (a.data.method !== undefined) setMethod(a.data.method);
    if (d.step <= startStep || d.step > QUESTIONS || first === null) return;
    // Questions 3 and 4 need the site verified: ask the API (it reuses the asset) rather than trust a cached page.
    if (d.step >= Q.focus && (firstAsset === null || !isVerified(firstAsset)))
      void ensureTargetAction(first.origin, first.host).then((r) => {
        if (!r.ok) return;
        setAsset(r.data);
        if (isVerified(r.data)) setStep(d.step);
      });
    else setStep(d.step);
  }, [draftId, restoreDraft, startStep, initialStep, first, firstAsset]);

  // Question 2 registers the site (the API reuses an existing one): the file needs its token, and only the API knows
  // whether the owner's word is accepted for it (a lab the operator listed) or the address is refused outright.
  // A known but unverified site is registered again too: the API re-applies its rules, so an address it now refuses
  // (an old metadata or console target) is refused here instead of offered a proof.
  const registered = useRef<string | null>(null);
  useEffect(() => {
    if (target === null || step < 2 || registered.current === target.origin || (asset !== null && isVerified(asset))) return;
    let active = true;
    void ensureTargetAction(target.origin, target.host).then((r) => {
      if (!active) return;
      if (r.ok || r.code === 'target_not_allowed') registered.current = target.origin;
      if (r.ok) setAsset(r.data);
      else if (r.code === 'target_not_allowed') setRefused({ origin: target.origin, message: r.message });
      else setError(r.message);
    });
    return () => {
      active = false;
    };
  }, [target, asset, step, method, attempt]);

  // A link to a fresh /audits/new while this order is open (sidebar New audit, the N key) may come from the router
  // cache with the same key: start a new order with a new draft id instead of keeping these answers.
  const urlDraft = useSearchParams().get('draft');
  useEffect(() => {
    if (urlDraft === null && mounted.current) router.replace(`/audits/new?draft=${crypto.randomUUID()}`);
  }, [urlDraft, router]);

  // The step is in the URL (so Back, reload and the sidebar draft land here), without a server round trip.
  useEffect(() => {
    const q = new URLSearchParams();
    if (target !== null) q.set('target', target.origin);
    q.set('step', String(step));
    q.set('draft', draftId);
    if (target !== null) q.set('a', JSON.stringify(carriedAnswers({ focus, text: focusText, care, method })));
    window.history.replaceState(window.history.state, '', `/audits/new?${q.toString()}`);
    if (mounted.current || step > 1) h1.current?.focus();
    mounted.current = true;
  }, [step, target, draftId, focus, focusText, care, method]);

  // Draft kept on this device, 300 ms after the last change, once there is a site. A change still waiting when the
  // order unmounts (browser Back straight after Continue) is written then, so Forward comes back to the same question.
  const unsavedDraft = useRef<(() => void) | null>(null);
  const refusedTarget = refused !== null && refused.origin === target?.origin;
  useEffect(() => {
    if (target === null || submitted.current) return;
    setSaved(false);
    // An address Blackwing refuses can never go further: it is not kept as a draft (and an earlier one goes).
    if (refusedTarget) {
      removeDraft(draftId);
      return;
    }
    const write = (): void => {
      unsavedDraft.current = null;
      if (submitted.current) return;
      saveDraft({
        id: draftId,
        origin: target.origin,
        host: target.host,
        step,
        answers: { focus, text: focusText, care, method },
        savedAt: new Date().toISOString(),
      });
    };
    unsavedDraft.current = write;
    const timer = window.setTimeout(() => {
      write();
      setSaved(true);
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draftId, target, step, focus, focusText, care, method, refusedTarget]);
  useEffect(
    () => () => {
      unsavedDraft.current?.();
    },
    [],
  );

  const go = (n: number): void => {
    setError(null);
    setStep(n);
  };

  const verified = asset !== null && isVerified(asset);
  const refusedHere = refused !== null && refused.origin === target?.origin ? refused.message : null;

  const back = useCallback((): void => {
    // Back skips what Continue skipped (question 2 has nothing to ask once the site is verified), but never past the
    // first question this order showed: question 2 then says the site is verified.
    const to = step === Q.focus && verified && startStep <= Q.site ? Q.site : step - 1;
    // Back from the first question shown leaves the order (Home is where it started).
    if (to < 1 || to < startStep) {
      router.push('/');
      return;
    }
    setError(null);
    setStep(to);
  }, [step, startStep, verified, router]);

  const next = async (): Promise<boolean> => {
    setError(null);
    if (step === 1) {
      const r = normalizeTarget(text);
      if (!r.ok) {
        setShowError(true);
        return false;
      }
      // Nothing is registered here: question 2 does that when it needs to (see above).
      const a = target?.origin === r.origin ? asset : (findKnown(assets, r.origin) ?? null);
      if (target?.origin !== r.origin) {
        setAttested(false);
        setMethod(recommendedProof(r.host));
      }
      setTarget(r);
      setAsset(a);
      go(a !== null && isVerified(a) ? Q.focus : Q.proof);
      return false;
    }
    if (step === 2) {
      if (target === null) return false;
      let a = asset;
      if (a === null) {
        if (method !== 'attest' || !attested) return false;
        const created = await ensureTargetAction(target.origin, target.host);
        if (!created.ok) {
          setError(created.message);
          return false;
        }
        a = created.data;
        setAsset(a);
      }
      if (!isVerified(a)) {
        if (method !== 'attest' || !attested) return false;
        const r = await attest(a, viewerName);
        if ('error' in r) {
          setError(r.error);
          return false;
        }
        setAsset(r.asset);
        refreshSidebar();
      }
      go(Q.focus);
      return false;
    }
    if (step === Q.focus) {
      go(Q.care);
      return false;
    }
    if (asset === null || target === null) return false;
    const r = await createAuditAction({
      assetId: asset.id,
      objective: composeObjective(focus, focusText),
      intrusiveness: chosenCare,
      minutes: limits?.minutes ?? null,
      requests: limits?.requests ?? null,
      costUsd: limits?.costUsd ?? null,
      excludedPaths: [],
      releaseProven: 'hold',
      testAccounts: [],
    });
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    submitted.current = true;
    removeDraft(draftId);
    refreshSidebar();
    // Replace, so browser Back does not reopen question 4 of an order that is already a plan.
    router.replace(`/audits/${r.data.id}`);
    return true;
  };

  const shownError = showError || text.includes('://');
  const canContinue =
    step === 1
      ? // Muted while the field shows its error, as on Home: a gold Continue that does nothing reads as a missed click.
        text.trim() !== '' && !(shownError && !normalizeTarget(text).ok)
      : step === 2
        ? refusedHere === null && (verified || (target !== null && method === 'attest' && attested))
        : step === Q.care
          ? asset !== null
          : true;

  /** Why Continue is not ready yet, said next to it (a disabled button alone does not explain itself). */
  const stepHint =
    step === 2 && !canContinue && refusedHere === null
      ? method === 'file'
        ? 'Put the file on the site and press Check now, or choose \u201cI\u2019m responsible for this system\u201d.'
        : 'Tick the box to confirm, then continue.'
      : null;

  const pressContinue = (): void => {
    footer.current?.querySelector<HTMLButtonElement>('[data-continue-wrap] button')?.click();
  };

  // Keys: Enter continues (fields handle their own Enter), Esc goes back, 1 to 9 pick an option.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('[role="dialog"]')) return;
      // While typing, Esc belongs to the field (it closes the browser's suggestions); it never leaves the order.
      if (typing(e.target)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        back();
        return;
      }
      if (e.key === 'Enter') {
        if (el !== null && (el.closest('button') !== null || el.closest('a') !== null)) return;
        e.preventDefault();
        pressContinue();
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      if (step === 2 && !verified && n <= 2) setMethod(n === 1 ? 'file' : 'attest');
      else if (step === Q.focus && n <= FOCUS_CHIPS.length) {
        const key = FOCUS_CHIPS[n - 1]?.key;
        if (key !== undefined) setFocus((f) => toggleFocus(f, key, !f.includes(key)));
      } else if (step === Q.care && n <= 2) setCare(n === 1 ? 'passive' : 'active_safe');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [back, step, verified]);

  const host = target?.host ?? '';
  const focusPhrase = composeObjective(focus, '').replace(/^Look for /, '').replace(/\.$/, '');
  const note = focusText.trim().replace(/\s+/g, ' ');
  /** What to look for, with the person's own note, as the ticket and the receipt read it. */
  const lookFor = `${focusPhrase.charAt(0).toUpperCase()}${focusPhrase.slice(1)}${note === '' ? '' : ` \u00b7 \u201c${note}\u201d`}`;
  const lines: TicketLine[] = [
    { label: 'Site', value: target === null ? null : target.host, warn: refusedHere !== null },
    {
      label: "Proof it's yours",
      value: verified ? (asset.ownership.method === 'http_token' ? 'File found on the site' : 'Verified earlier') : null,
    },
    { label: 'What to look for', value: step >= Q.focus ? lookFor : null },
    { label: 'How careful', value: step >= Q.care ? CARE[chosenCare].label : null },
  ];
  const details: TicketDetail[] = [
    { label: 'Paths to avoid', value: 'None', tag: 'Default' },
    { label: 'Signed-in testing', value: 'As a visitor', tag: 'Default' },
    // The limits come from the workspace; when they did not load, the row is left out rather than stating none.
    ...(limits === null
      ? []
      : [
          {
            label: 'Limits',
            value: `${limits.minutes} min · ${limits.requests.toLocaleString('en-US')} req · ${usd(limits.costUsd)}`,
            tag: 'Suggested' as const,
          },
        ]),
    { label: 'Proven issues', value: 'Wait for your release', tag: 'Default' },
  ];
  const ticketProps = { lines, current: step - 1, details, saved };

  const heads: Record<number, { h1: ReactNode; lede: ReactNode }> = {
    1: {
      h1: 'What should we audit?',
      lede: "Paste the address of a web app you own. I'll show you exactly what I understood.",
    },
    2: {
      h1: (
        <>
          Is <Host text={host} /> yours?
        </>
      ),
      lede: verified
        ? 'Nothing to do here: the site is already verified as yours.'
        : refusedHere !== null
          ? 'Blackwing cannot test this address, whoever owns it. Change the site to go on.'
          : 'We only test sites you can show you control. Pick the way that suits you.',
    },
    3: {
      h1: 'What should Claude look for?',
      lede: "Pick areas to focus on, or keep the broad OWASP sweep. I'll turn your choice into the objective, and you can change it on the plan.",
    },
    4: {
      h1: 'How careful should Claude be?',
      lede: (
        <>
          How Claude&apos;s agents may touch{' '}
          <b className="font-medium text-foreground">
            <Host text={host} after="." />
          </b>
        </>
      ),
    },
  };
  const head = heads[step] ?? heads[1];

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-8 lg:grid-cols-[minmax(0,640px)_340px] lg:justify-center lg:gap-10">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={back}
            aria-label="Back"
            className={buttonClass('ghost', '-ml-2 size-9 shrink-0 px-0 md:hidden')}
          >
            <Icon name="arrow" size={18} className="rotate-180" />
          </button>
          <span className="hidden text-[12.5px] text-muted-foreground sm:inline">New audit</span>
          <span className="hidden flex-1 sm:block" />
          <span aria-hidden="true" className="flex gap-1">
            {STEPS.map((i) => (
              <span
                key={i}
                className={`h-[3px] w-4 rounded-full sm:w-10 ${i < step ? 'bg-gold-ink' : i === step ? 'bg-gold' : 'bg-border-strong'}`}
              />
            ))}
          </span>
          <span className="whitespace-nowrap text-[12.5px] tabular-nums text-muted-foreground">
            Question {step} of {QUESTIONS}
          </span>
          <span className="flex-1 sm:hidden" />
          <TicketPill {...ticketProps} />
        </div>

        {step > 1 && target !== null ? (
          <Receipt
            label="Site"
            warn={refusedHere !== null}
            value={target.display}
            onChange={() => {
              setText(target.display);
              go(1);
            }}
          />
        ) : null}
        {step > 2 && verified ? (
          <Receipt label="Proof" value={lines[1]?.value ?? ''} onChange={() => { go(2); }} />
        ) : null}
        {step > Q.focus ? <Receipt label="Look for" value={lookFor} onChange={() => { go(Q.focus); }} /> : null}

        <section
          aria-labelledby="order-h1"
          className="flex flex-col gap-5"
          onFocusCapture={(e) => {
            setInText(e.target instanceof HTMLTextAreaElement);
          }}
          onBlurCapture={() => {
            setInText(false);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <h1
              id="order-h1"
              ref={h1}
              tabIndex={-1}
              className="m-0 text-[26px] font-semibold leading-[34px] tracking-[-0.01em] text-foreground focus:outline-none sm:text-[28px] sm:leading-[36px]"
            >
              {head?.h1}
            </h1>
            <p className="m-0 text-[15px] leading-6 text-muted-foreground">{head?.lede}</p>
          </div>
          <p className="sr-only" aria-live="polite">
            Question {step} of {QUESTIONS}
          </p>

          {step === 1 ? (
            <AskField
              id="order-target"
              label="Web address"
              text={text}
              onText={(t) => {
                setText(t);
                setShowError(false);
              }}
              result={live}
              known={assets}
              showError={shownError}
              onBlur={() => {
                setShowError(text.trim() !== '');
              }}
              onEnter={pressContinue}
              autoFocus
            />
          ) : null}

          {step === 2 && refusedHere !== null ? (
            <InlineMessage tone="bad">
              {refusedHere}{' '}
              <button
                type="button"
                onClick={() => {
                  go(1);
                }}
                className="rounded font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              >
                Use another address
              </button>
            </InlineMessage>
          ) : step === 2 ? (
            <VerifyOwnership
              asset={asset}
              origin={target?.origin ?? null}
              viewerName={viewerName}
              method={method}
              onMethod={setMethod}
              attested={attested}
              onAttested={setAttested}
              onVerified={(a) => {
                setAsset(a);
                refreshSidebar();
              }}
              showIndex
              primaryCheck
            />
          ) : null}

          {step === Q.focus ? (
            <FocusPicker keys={focus} onKeys={setFocus} text={focusText} onText={setFocusText} onSubmit={pressContinue} showIndex />
          ) : null}

          {step === Q.care ? (
            <div className="flex flex-col gap-3">
              <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
                <legend className="sr-only">How careful</legend>
                {(['passive', 'active_safe'] as const).map((c, i) => (
                  <OptionCard
                    key={c}
                    name="care"
                    value={c}
                    checked={chosenCare === c}
                    onChange={() => {
                      setCare(c);
                    }}
                    title={CARE[c].label}
                    description={CARE[c].line}
                    badge={
                      recommendedCare(host) === c ? <span className={RECOMMEND_PILL}>{CARE[c].badge}</span> : undefined
                    }
                    index={i + 1}
                  />
                ))}
              </fieldset>
              <p className="m-0 flex items-start gap-2 rounded-[12px] bg-surface-2 px-3.5 py-3 text-[13px] leading-5 text-muted-foreground">
                <Icon name="shield" size={15} className="mt-0.5 shrink-0" />
                Probing gently, anything that would change data waits for your yes. Only looking, it is refused. Either way,
                destructive requests (like DELETE) are never sent.
              </p>
              <p className="m-0 text-[12.5px] text-muted-foreground">
                {limits === null
                  ? "Next, I'll read the plan back with your workspace's suggested limits."
                  : `Next, I'll read the plan back: suggested limits are ${limitsPhrase(limits)}.`}
              </p>
            </div>
          ) : null}
        </section>

        {error === null ? null : (
          <InlineMessage tone="bad">
            {/* The button below is the fix, so the message does not say it twice. */}
            {error.replace(/;\s*try again[^.]*\.$/i, '.')}{' '}
            <button
              type="button"
              onClick={() => {
                // A failed registration has no Continue to press yet (the file way needs it first): run it again.
                if (step === Q.proof && asset === null && method === 'file') {
                  setError(null);
                  setAttempt((n) => n + 1);
                } else pressContinue();
              }}
              className="rounded font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              Try again
            </button>
          </InlineMessage>
        )}

        {/* Phones: Continue is pinned full width to the bottom of the screen (Back is in the top row); the spacer keeps
            the last option above it. */}
        <div aria-hidden="true" className="h-[120px] md:hidden" />
        <div
          ref={footer}
          className="fixed inset-x-0 bottom-0 z-20 flex flex-col gap-2 border-t border-border bg-bg px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 md:static md:z-auto md:flex-row md:flex-wrap md:items-center md:gap-3 md:border-0 md:bg-transparent md:p-0 md:py-1"
        >
          {stepHint === null ? null : (
            <p id="order-hint" className="m-0 text-[12.5px] leading-[18px] text-muted-foreground md:order-4 md:basis-full">
              {stepHint}
            </p>
          )}
          <span className="flex [&_button]:w-full md:order-1 md:[&_button]:w-auto">
            <ContinueButton
              step={step}
              disabled={!canContinue}
              onAction={next}
              describedBy={stepHint === null ? undefined : 'order-hint'}
            />
          </span>
          <button type="button" onClick={back} className={buttonClass('ghost', 'h-12 px-4 max-md:hidden md:order-2')}>
            Back
          </button>
          <span className="hidden text-[12.5px] text-muted-foreground md:order-3 md:inline">
            {inText ? 'Ctrl+Enter to continue' : 'Enter to continue · Esc to go back'}
          </span>
        </div>
      </div>
      <div className="hidden lg:block">
        <div className="sticky top-7">
          <Ticket {...ticketProps} />
        </div>
      </div>
    </div>
  );
}

function ContinueButton({
  step,
  disabled,
  onAction,
  describedBy,
}: {
  readonly step: number;
  readonly disabled: boolean;
  readonly onAction: () => Promise<boolean>;
  readonly describedBy: string | undefined;
}) {
  const pending: Record<number, string> = {
    1: 'Checking…',
    2: 'Recording…',
    3: 'Continuing…',
    4: 'Preparing the plan…',
  };
  return (
    <span data-continue-wrap className="contents">
      <PendingButton
        onAction={onAction}
        disabled={disabled}
        stayPending={step === QUESTIONS}
        pendingLabel={pending[step] ?? 'Continuing…'}
        className="h-12 rounded-xl px-[22px] text-[14.5px]"
        {...(describedBy === undefined ? {} : { describedBy })}
      >
        Continue
        <Icon name="arrow" size={16} />
      </PendingButton>
    </span>
  );
}
