'use client';

// "Continue where it left off": a run that stopped at one of its limits with test cases still untried asks whether to
// carry on. The copy keeps the answers and test accounts, names the untried cases and the proven findings (so they are
// not proven again), and takes the limits chosen here. It opens at its plan: Gate 1 still approves it.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { InlineMessage } from '../design';
import { PendingButton } from '../design-client';
import { limitSettingsAction, runAgainAction } from './actions';
import { useNudge } from './nudge';
import { LimitsEditor, type LimitValues } from '../order/plan-editors';

import type { Workspace } from '../../../lib/schemas';

const LIMIT_WORDS: Readonly<Record<string, string>> = {
  duration_budget: 'its time limit',
  request_budget: 'its request limit',
  cost_cap: 'its spending limit',
};

/** Whether a run's end reason is one of its limits (the card shows only then). */
export const stoppedAtLimit = (endReason: string | null | undefined): boolean =>
  endReason !== null && endReason !== undefined && endReason in LIMIT_WORDS;

export function ContinueCard({
  requestId,
  runId,
  endReason,
  untried,
  current,
}: {
  readonly requestId: string;
  readonly runId: string;
  readonly endReason: string;
  readonly untried: number;
  /** The limits this run had: the card suggests the next bigger tier. */
  readonly current: LimitValues;
}) {
  const router = useRouter();
  const nudge = useNudge();
  const [settings, setSettings] = useState<Workspace['settings'] | null>(null);
  const [limits, setLimits] = useState<LimitValues | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storeKey = `bw:continue-dismissed:${runId}`;

  useEffect(() => {
    try {
      if (window.localStorage.getItem(storeKey) === '1') setDismissed(true);
    } catch {
      // Storage blocked: the card simply shows.
    }
    void limitSettingsAction().then((s) => {
      if (s === null) return;
      setSettings(s);
      const bigger = s.presets.find((p) => p.minutes > current.minutes || p.requests > current.requests) ?? s.presets.at(-1);
      setLimits(bigger === undefined ? current : { minutes: bigger.minutes, requests: bigger.requests, costUsd: bigger.costUsd });
    });
  }, [storeKey, current]);

  if (dismissed) return null;
  const cases = untried === 1 ? '1 test case' : `${untried} test cases`;
  return (
    <section
      aria-label="Continue this audit"
      className="mx-4 mt-3 flex flex-col gap-3 rounded-[14px] border border-gold-line bg-gold-soft p-4 md:mx-6"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold leading-[22px]">
          Stopped at {LIMIT_WORDS[endReason] ?? 'a limit'} with {cases} left. Continue where it left off?
        </h2>
        <p className="m-0 text-[13px] leading-5 text-muted-foreground">
          The next audit picks up the untried cases and skips what is already proven. Pick its limits; you approve the plan before it starts.
        </p>
      </div>
      {settings === null || limits === null ? null : (
        <LimitsEditor value={limits} onChange={setLimits} settings={settings} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <PendingButton
          icon="repeat"
          pendingLabel="Preparing the plan…"
          stayPending
          disabled={limits === null}
          className="h-10"
          onAction={async () => {
            setError(null);
            const result = await runAgainAction(requestId, runId, limits);
            if (!result.ok) {
              setError(`We couldn't prepare the next audit: ${result.message}`);
              return false;
            }
            const to = `/audits/${encodeURIComponent(result.data.id)}`;
            window.dispatchEvent(new Event('bw:refresh'));
            router.push(to);
            nudge(() => window.location.pathname === to);
            return true;
          }}
        >
          Continue with {cases}
        </PendingButton>
        <PendingButton
          variant="secondary"
          pendingLabel="Hiding…"
          className="h-10"
          onAction={() => {
            try {
              window.localStorage.setItem(storeKey, '1');
            } catch {
              // Storage blocked: hidden for this visit only.
            }
            setDismissed(true);
            return Promise.resolve(true);
          }}
        >
          Not now
        </PendingButton>
      </div>
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
    </section>
  );
}
