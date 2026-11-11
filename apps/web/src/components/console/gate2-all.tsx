/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// "Allow all" and "Deny all" for the Gate 2 requests the person is looking at (the Decisions inbox, or one live
// audit). Only the ids shown here are sent. Allowing lists every request (method, path, role) beside one shared
// reason, with the same minimum as a single Allow. The server decides each through the single-decision path, so a
// request closed meanwhile comes back as such and is never forced.
import { useState } from 'react';
import { z } from 'zod';

import { buttonClass, InlineMessage } from './design';
import { PendingButton, ReasonField } from './design-client';
import { announceDecided, fetchGate2 } from './gate2-actions';
import { pathOf } from './run-model';
import { reasonEnough } from '../../lib/normalize';

export interface AllRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  /** Null: sent without signing in. */
  readonly role: string | null;
}

const MAX_REASON = 500;
const NEAR_LIMIT = 400;
const TIMEOUT_MS = 30_000;
const REASONS = ['Our own test lab', 'Test accounts we own', 'Needed to prove the findings'] as const;

const answerSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      result: z.enum(['decided', 'already_decided', 'expired', 'closed', 'not_found']),
    }),
  ),
  decided: z.number(),
});
const problemSchema = z.object({ message: z.string().optional() }).loose();

type Outcome =
  | { readonly ok: true; readonly decided: number; readonly notDecided: number }
  | { readonly ok: false; readonly message: string | null };

async function postDecideAll(
  ids: readonly string[],
  decision: 'approve' | 'deny',
  reason: string,
): Promise<Outcome> {
  try {
    const res = await fetch('/api/gate2/decide-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ ids, decision, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }),
    });
    const json: unknown = await res.json().catch(() => null);
    const parsed = res.ok ? answerSchema.safeParse(json) : null;
    if (parsed?.success === true) {
      // Every card shows the server's own receipt, whoever decided it.
      const answered = parsed.data.results.filter((r) => r.result !== 'not_found').map((r) => r.id);
      const details = await Promise.all(answered.map((id) => fetchGate2(id)));
      for (const d of details) if (d !== null && d.status !== 'pending') announceDecided(d);
      window.dispatchEvent(new Event('bw:refresh'));
      return { ok: true, decided: parsed.data.decided, notDecided: ids.length - parsed.data.decided };
    }
    const problem = problemSchema.safeParse(json);
    return { ok: false, message: res.status >= 500 || !problem.success ? null : (problem.data.message ?? null) };
  } catch {
    return { ok: false, message: null };
  }
}

const noun = (n: number): string => (n === 1 ? 'request' : 'requests');

/**
 * `requests` are the open ones on screen. `scope` words the bar: the inbox ("N waiting") or one audit ("Allow all N
 * for this run"). Nothing renders for fewer than two.
 */
export function DecideAllBar({
  requests,
  scope,
}: {
  readonly requests: readonly AllRequest[];
  readonly scope: 'inbox' | 'run';
}) {
  const [mode, setMode] = useState<'idle' | 'allow' | 'deny'>('idle');
  const [reason, setReason] = useState('');
  const [failed, setFailed] = useState<string | false>(false);
  const [left, setLeft] = useState(0);
  const n = requests.length;
  if (n < 2 && mode === 'idle' && left === 0) return null;
  const ids = requests.map((r) => r.id);
  const close = (): void => {
    setMode('idle');
    setFailed(false);
  };
  const run = async (decision: 'approve' | 'deny'): Promise<boolean> => {
    setFailed(false);
    const out = await postDecideAll(ids, decision, decision === 'approve' ? reason : '');
    if (!out.ok) {
      setFailed(out.message ?? "Couldn't record your decisions.");
      return false;
    }
    setLeft(out.notDecided);
    setReason('');
    setMode('idle');
    return true;
  };
  const forRun = scope === 'run';
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[12px] border border-border bg-card px-3.5 py-2.5"
      data-gate2-all=""
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="m-0 min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground">{n} waiting</span>
          {left > 0 && n < 2 ? ` · ${left} could not be decided here, check them one by one` : null}
        </p>
        {mode === 'idle' && n >= 2 ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setMode('allow');
              }}
              className={buttonClass('secondary', 'h-8 border-input-strong! px-3 text-[12.5px] max-sm:h-11')}
            >
              {forRun ? `Allow all ${n} for this run…` : 'Allow all…'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('deny');
              }}
              className={buttonClass('ghost', 'h-8 px-2.5 text-[12.5px] max-sm:h-11')}
            >
              Deny all
            </button>
          </div>
        ) : null}
      </div>
      {mode === 'idle' && left > 0 && n >= 2 ? (
        <InlineMessage tone="bad">
          {left} {noun(left)} could not be decided here (closed meanwhile or not recorded). They stay as they are.
        </InlineMessage>
      ) : null}
      {mode === 'deny' ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span className="mr-auto text-[12.5px] text-muted-foreground">
            Deny {n} {noun(n)}? Blackwing will not send them.
          </span>
          <button type="button" onClick={close} className={buttonClass('ghost', 'h-8 px-2.5 text-[12.5px] max-sm:h-11')}>
            Keep them
          </button>
          <PendingButton
            variant="deny"
            pendingLabel="Denying…"
            stayPending
            onAction={() => run('deny')}
            className="h-8 px-3 text-[12.5px] max-sm:h-11"
          >
            Deny all {n}
          </PendingButton>
        </div>
      ) : null}
      {mode === 'allow' ? (
        <div className="flex flex-col gap-2.5">
          <ul className="m-0 flex max-h-44 list-none flex-col gap-0.5 overflow-y-auto p-0 text-[12.5px] leading-5">
            {requests.map((r) => (
              <li key={r.id} className="flex min-w-0 gap-2">
                <span className="w-14 shrink-0 font-mono text-[11.5px] font-semibold">{r.method.toUpperCase()}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={pathOf(r.url)}>
                  {pathOf(r.url).split('?')[0]}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {r.role === null ? 'no sign-in' : `as ${r.role}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="m-0 text-[12px] leading-[17px] text-muted-foreground">
            Allowing covers each method, path and role above, from any agent and with any body, until its audit ends.
            Blackwing won&apos;t ask about them again.
          </p>
          <ReasonField
            label="One reason for all of them (needed to allow)"
            value={reason}
            onChange={(text) => {
              setReason(text.slice(0, MAX_REASON));
            }}
            onSubmit={() => undefined}
            placeholder="Why is it safe to allow all of these?"
            suggestions={REASONS}
            footnote={
              reason.length < NEAR_LIMIT
                ? 'Kept on the ledger with your name, once on each request'
                : `${reason.length} of ${MAX_REASON} characters, the most a reason can hold`
            }
            autoFocus
            rows={2}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" onClick={close} className={buttonClass('ghost', 'h-10')}>
              Cancel
            </button>
            <PendingButton
              variant="primary"
              pendingLabel="Allowing…"
              disabled={!reasonEnough(reason)}
              title={reasonEnough(reason) ? undefined : 'Write a reason of at least 8 characters first'}
              stayPending
              onAction={() => run('approve')}
              className="h-10"
            >
              Allow all {n}
            </PendingButton>
          </div>
        </div>
      ) : null}
      {failed === false ? null : (
        <InlineMessage tone="bad">
          {failed} Nothing was lost: they are still open, so try again or decide each one.
        </InlineMessage>
      )}
    </div>
  );
}
