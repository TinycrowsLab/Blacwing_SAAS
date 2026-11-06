'use client';

// Home's greeting and the one field (experience spec §3.2). The greeting follows the reader's local time; Begin opens
// the order at question 2, or 3 when the site is already verified.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useSyncExternalStore } from 'react';

import { AskField, findKnown, useKnownTargets, useNormalized, type WaitingPlan } from './ask-field';
import { greetingFor, isVerified } from './shared';
import { normalizeTarget } from '../../../lib/normalize';
import { Icon } from '../design';
import { PendingButton } from '../design-client';

const PROOF_STEP = 2;
const FOCUS_STEP = 3;

const noSubscribe = (): (() => void) => () => undefined;

export function HomeAsk({
  givenName,
  serverGreeting,
  named,
  waiting,
}: {
  readonly givenName: string;
  /** The greeting at the server's hour, so the first paint matches; the reader's own clock takes over at once. */
  readonly serverGreeting: string;
  /** Just named on /welcome: the one-time note under the greeting. */
  readonly named: boolean;
  /** Plans waiting for approval: a site that already has one says so (no second plan by accident). */
  readonly waiting: readonly WaitingPlan[];
}) {
  const router = useRouter();
  const greeting = useSyncExternalStore(
    noSubscribe,
    () => greetingFor(new Date().getHours()),
    () => serverGreeting,
  );
  const [text, setText] = useState('');
  const [showError, setShowError] = useState(false);
  const [note, setNote] = useState(named);
  const result = useNormalized(text);
  const known = useKnownTargets();
  const begin = useRef<HTMLDivElement>(null);
  const shownError = showError || text.includes('://');
  // Muted while the field shows its error: a gold Begin that does nothing reads as a missed click.
  const blocked = text.trim() === '' || (shownError && !normalizeTarget(text).ok);

  const go = (): boolean => {
    const r = normalizeTarget(text);
    if (!r.ok) {
      setShowError(true);
      return false;
    }
    const existing = findKnown(known, r.origin);
    // Question 3 when the site is already verified (ownership is settled), otherwise question 2.
    const step = existing !== undefined && isVerified(existing) ? FOCUS_STEP : PROOF_STEP;
    router.push(`/audits/new?target=${encodeURIComponent(r.origin)}&step=${step}`);
    return true;
  };

  const button = (
    <PendingButton
      onAction={go}
      stayPending
      disabled={blocked}
      pendingLabel="Opening…"
      className="h-12 w-full rounded-xl px-[22px] text-[14.5px] sm:w-auto"
    >
      Begin
      <Icon name="arrow" size={16} />
    </PendingButton>
  );

  return (
    <div className="flex flex-col gap-6">
      <span className="flex size-11 items-center justify-center rounded-[12px] bg-gold-soft shadow-[inset_0_0_0_1px_var(--gold-line)]">
        <img src="/brand/crow-shield.png" alt="" width={24} height={24} className="object-contain" />
      </span>
      <div className="flex flex-col gap-3">
        <h1 className="m-0 text-[30px] font-semibold leading-[38px] tracking-[-0.02em] text-foreground sm:text-[36px] sm:leading-[46px]">
          {greeting}, {givenName}.
        </h1>
        {note ? (
          <p className="m-0 flex w-fit items-center gap-2 rounded-full bg-gold-soft py-1 pl-3 pr-1 text-[12.5px] text-gold-ink shadow-[inset_0_0_0_1px_var(--gold-line)]">
            Named from your Google account.
            <Link href="/settings" className="font-semibold underline underline-offset-2">
              Rename
            </Link>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                setNote(false);
                window.history.replaceState(window.history.state, '', '/');
              }}
              className="flex size-6 items-center justify-center rounded-full hover:bg-gold-line focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              <Icon name="x" size={12} />
            </button>
          </p>
        ) : null}
        <p className="m-0 max-w-[700px] text-[16px] leading-[26px] text-muted-foreground sm:text-[17px] sm:leading-[28px]">
          I&apos;ll arrange a security audit of a web app you own. I&apos;ll ask a few short questions, show you the plan,
          and nothing is tested until you approve it.
        </p>
      </div>
      <div ref={begin} data-begin className="flex flex-col gap-2.5">
        <AskField
          id="home-target"
          label="What should we audit?"
          variant="hero"
          text={text}
          onText={(t) => {
            setText(t);
            setShowError(false);
          }}
          result={result}
          known={known}
          showError={shownError}
          onBlur={() => {
            setShowError(text.trim() !== '');
          }}
          onEnter={() => {
            if (blocked) setShowError(true);
            else begin.current?.querySelector<HTMLButtonElement>('button')?.click();
          }}
          action={button}
          waiting={waiting}
          autoFocus
        />
        <div className="hidden flex-wrap gap-2 text-[12px] text-muted-foreground sm:flex">
          <span className="rounded-full bg-surface-2 px-2.5 py-1">A web address, an IP with a port, or a full URL all work</span>
          <span className="rounded-full bg-surface-2 px-2.5 py-1">
            Press <b className="font-semibold text-foreground">Enter</b> to begin
          </span>
        </div>
      </div>
    </div>
  );
}
