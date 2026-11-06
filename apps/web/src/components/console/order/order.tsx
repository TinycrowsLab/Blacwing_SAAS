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
  recommendedCare,
  refreshSidebar,
  toggleFocus,
  typing,
} from './shared';
import { Ticket, TicketPill, type TicketDetail, type TicketLine } from './ticket';
import { attest, type ProofMethod, VerifyOwnership } from './verify-ownership';
import { createAuditAction, ensureTargetAction } from '../../../app/(console)/audits/actions';
import { readDrafts, removeDraft, saveDraft } from '../../../lib/drafts';
import { normalizeTarget, type TargetResult } from '../../../lib/normalize';
import { limitsPhrase } from '../../../lib/plan-text';
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

/** A host that wraps after its dots and colon on a phone, never mid-label. */
function Breakable({ text }: { readonly text: string }) {
  return text.split(/(?<=[.:])/).map((part, i) => (
    <Fragment key={i}>
      {i === 0 ? null : <wbr />}
      {part}
    </Fragment>
  ));
}

function Receipt({ label, value, onChange }: { readonly label: string; readonly value: ReactNode; readonly onChange: () => void }) {
  return (
    <div className="hidden min-h-11 items-center gap-3 rounded-[12px] border border-border bg-card px-4 py-2 md:flex">
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
        <Icon name="check" size={11} />
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
  const [method, setMethod] = useState<ProofMethod>('file');
  const [attested, setAttested] = useState(false);
  const [focus, setFocus] = useState<FocusKey[]>([BROAD]);
  const [focusText, setFocusText] = useState('');
  const [care, setCare] = useState<Care | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const h1 = useRef<HTMLHeadingElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const live = useNormalized(text);

  const chosenCare: Care = care ?? (target === null ? 'passive' : recommendedCare(target.host));

  // A draft from the sidebar brings its answers back (this device only).
  useEffect(() => {
    if (!restoreDraft) return;
    const d = readDrafts().find((x) => x.id === draftId);
    if (d === undefined) return;
    const a = answersSchema.safeParse(d.answers);
    if (!a.success) return;
    if (a.data.focus !== undefined && a.data.focus.length > 0) setFocus(a.data.focus);
    if (a.data.text !== undefined) setFocusText(a.data.text);
    if (a.data.care !== undefined) setCare(a.data.care);
    if (a.data.method !== undefined) setMethod(a.data.method);
  }, [restoreDraft, draftId]);

  // Coming from Home with a new site: register it (the API reuses an existing one) so question 2 has its token.
  useEffect(() => {
    if (target === null || asset !== null || step < 2) return;
    let active = true;
    void ensureTargetAction(target.origin, target.host).then((r) => {
      if (!active) return;
      if (r.ok) setAsset(r.data);
      else setError(r.message);
    });
    return () => {
      active = false;
    };
  }, [target, asset, step]);

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
    window.history.replaceState(window.history.state, '', `/audits/new?${q.toString()}`);
    if (mounted.current || step > 1) h1.current?.focus();
    mounted.current = true;
  }, [step, target, draftId]);

  // Draft kept on this device, 300 ms after the last change, once there is a site.
  useEffect(() => {
    if (target === null) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      saveDraft({
        id: draftId,
        origin: target.origin,
        host: target.host,
        step,
        answers: { focus, text: focusText, care, method },
        savedAt: new Date().toISOString(),
      });
      setSaved(true);
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draftId, target, step, focus, focusText, care, method]);

  const go = (n: number): void => {
    setError(null);
    setStep(n);
  };

  const back = useCallback((): void => {
    // Back from the first question shown leaves the order (Home is where it started).
    if (step === 1 || step <= startStep) {
      router.push('/');
      return;
    }
    setError(null);
    setStep((s) => Math.max(1, s - 1));
  }, [step, startStep, router]);

  const verified = asset !== null && isVerified(asset);

  const next = async (): Promise<boolean> => {
    setError(null);
    if (step === 1) {
      const r = normalizeTarget(text);
      if (!r.ok) {
        setShowError(true);
        return false;
      }
      let a = target?.origin === r.origin ? asset : (findKnown(assets, r.origin) ?? null);
      if (a === null) {
        const created = await ensureTargetAction(r.origin, r.host);
        if (!created.ok) {
          setError(created.message);
          return false;
        }
        a = created.data;
      }
      if (target?.origin !== r.origin) setAttested(false);
      setTarget(r);
      setAsset(a);
      go(isVerified(a) ? Q.focus : Q.proof);
      return false;
    }
    if (step === 2) {
      if (asset === null) return false;
      if (!isVerified(asset)) {
        if (method !== 'attest' || !attested) return false;
        const r = await attest(asset, viewerName);
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
    if (limits === null) {
      setError("We couldn't load your workspace limits. Reload the page and try again.");
      return false;
    }
    const r = await createAuditAction({
      assetId: asset.id,
      objective: composeObjective(focus, focusText),
      intrusiveness: chosenCare,
      minutes: limits.minutes,
      requests: limits.requests,
      costUsd: limits.costUsd,
      excludedPaths: [],
      releaseProven: 'hold',
      testAccounts: [],
    });
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    removeDraft(draftId);
    refreshSidebar();
    router.push(`/audits/${r.data.id}`);
    return true;
  };

  const canContinue =
    step === 1
      ? live.ok || text.trim() !== ''
      : step === 2
        ? verified || (asset !== null && method === 'attest' && attested)
        : step === Q.care
          ? asset !== null
          : true;

  const pressContinue = (): void => {
    footer.current?.querySelector<HTMLButtonElement>('[data-continue-wrap] button')?.click();
  };

  // Keys: Enter continues (fields handle their own Enter), Esc goes back, 1 to 9 pick an option.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('[role="dialog"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        back();
        return;
      }
      if (typing(e.target)) return;
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
  const lines: TicketLine[] = [
    { label: 'Site', value: target === null ? null : target.host },
    {
      label: "Proof it's yours",
      value: verified ? (asset.ownership.method === 'http_token' ? 'File found on the site' : 'Confirmed by you') : null,
    },
    { label: 'What to look for', value: step >= Q.focus ? focusPhrase.charAt(0).toUpperCase() + focusPhrase.slice(1) : null },
    { label: 'How careful', value: step >= Q.care ? CARE[chosenCare].label : null },
  ];
  const details: TicketDetail[] = [
    { label: 'Paths to avoid', value: 'None', tag: 'Default' },
    { label: 'Signed-in testing', value: 'As a visitor', tag: 'Default' },
    ...(limits === null
      ? []
      : [
          {
            label: 'Limits',
            value: `${limits.minutes} min · ${limits.requests.toLocaleString()} req · $${limits.costUsd}`,
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
          Is{' '}
          <span className="[overflow-wrap:anywhere]">
            <Breakable text={host} />
          </span>{' '}
          yours?
        </>
      ),
      lede: 'We only test sites you can show you control. Pick the way that suits you.',
    },
    3: {
      h1: 'What should Claude look for?',
      lede: "Pick as many as you like. I'll turn them into the objective, and you can change it on the plan.",
    },
    4: {
      h1: 'How careful should Claude be?',
      lede: (
        <>
          How Claude&apos;s agents may touch <b className="font-medium text-foreground">{host}</b>.
        </>
      ),
    },
  };
  const head = heads[step] ?? heads[1];

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-8 lg:grid-cols-[minmax(0,640px)_340px] lg:justify-between">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="hidden text-[12.5px] text-muted-foreground sm:inline">New audit</span>
          <span className="hidden flex-1 sm:block" />
          <span aria-hidden="true" className="flex gap-1">
            {STEPS.map((i) => (
              <span
                key={i}
                className={`h-[3px] w-5 rounded-full sm:w-10 ${i < step ? 'bg-gold-ink' : i === step ? 'bg-gold' : 'bg-border-strong'}`}
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
        {step > Q.focus ? <Receipt label="Look for" value={lines[2]?.value ?? ''} onChange={() => { go(Q.focus); }} /> : null}

        <section aria-labelledby="order-h1" className="flex flex-col gap-5">
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
              showError={showError || text.includes('://')}
              onBlur={() => {
                setShowError(text.trim() !== '');
              }}
              onEnter={pressContinue}
              autoFocus
            />
          ) : null}

          {step === 2 ? (
            <VerifyOwnership
              asset={asset}
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
                      recommendedCare(host) === c ? (
                        <span className="inline-flex h-5 items-center rounded-md bg-gold-soft px-2 text-[11px] font-semibold text-gold-ink">
                          {CARE[c].badge}
                        </span>
                      ) : undefined
                    }
                    index={i + 1}
                  />
                ))}
              </fieldset>
              <p className="m-0 flex items-start gap-2 rounded-[12px] bg-surface-2 px-3.5 py-3 text-[13px] leading-5 text-muted-foreground">
                <Icon name="shield" size={15} className="mt-0.5 shrink-0" />
                Either way, anything that would change data waits for your yes, and destructive requests (like DELETE) are
                never sent.
              </p>
              {limits === null ? null : (
                <p className="m-0 text-[12.5px] text-muted-foreground">
                  Next, I&apos;ll read the plan back: suggested limits are {limitsPhrase(limits)}.
                </p>
              )}
            </div>
          ) : null}
        </section>

        {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}

        <div
          ref={footer}
          className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-border bg-bg px-4 py-3 sm:-mx-6 sm:px-6 md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-1"
        >
          <button type="button" onClick={back} className={buttonClass('ghost', 'h-12 px-4 md:order-2')}>
            Back
          </button>
          <span className="flex flex-1 md:order-1 md:flex-none [&_button]:w-full md:[&_button]:w-auto">
            <ContinueButton
              step={step}
              disabled={!canContinue}
              onAction={next}
              title={step === 2 && !canContinue ? 'Verify ownership first' : undefined}
            />
          </span>
          <span className="hidden text-[12.5px] text-muted-foreground md:order-3 md:inline">
            Enter to continue · Esc to go back
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
  title,
}: {
  readonly step: number;
  readonly disabled: boolean;
  readonly onAction: () => Promise<boolean>;
  readonly title: string | undefined;
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
        {...(title === undefined ? {} : { title })}
      >
        Continue
        <Icon name="arrow" size={16} />
      </PendingButton>
    </span>
  );
}
