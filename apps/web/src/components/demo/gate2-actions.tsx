/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Gate 2 countdown and the Deny / Approve once buttons. When the clock reaches zero the request is denied by the
// worker, so the buttons disable. The API refuses a late decision too (409 gate2_closed).
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { buttonClass, Icon, INPUT_CLASS } from './design';
import { secondsLeft } from './run-model';
import { useNow } from './use-now';

const MIN_REASON = 8;

/** `initialLeft` is the server's `secondsLeft`: the server render and the first client render both show it. */
export function useGate2Clock(
  deadlineAt: string,
  createdAt: string | undefined,
  pending: boolean,
  initialLeft: number,
) {
  const now = useNow(pending);
  const mounted = now > 0;
  const live = pending && mounted ? secondsLeft(deadlineAt, now) : 0;
  const total =
    createdAt === undefined
      ? live
      : Math.max(
          1,
          Math.round((new Date(deadlineAt).getTime() - new Date(createdAt).getTime()) / 1000),
        );
  const left = pending && !mounted ? initialLeft : live;
  return { left, total: Math.max(total, left, 1) };
}

export function Gate2Buttons({
  gate2Id,
  open,
  size = 'md',
  onDecided,
}: {
  readonly gate2Id: string;
  readonly open: boolean;
  readonly size?: 'md' | 'lg';
  readonly onDecided?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function decide(decision: 'approve' | 'deny') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/demo/api/gate2/${encodeURIComponent(gate2Id)}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
        }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { message?: unknown };
        throw new Error(
          typeof problem.message === 'string' ? problem.message : 'The decision was refused.',
        );
      }
      onDecided?.();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The decision failed.');
    } finally {
      setBusy(false);
    }
  }

  const h = size === 'lg' ? 'h-12 px-8 text-[14.5px] font-semibold' : 'h-10';
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-[12.5px] font-medium">
        <span>
          Reason <span className="font-normal text-muted-foreground">(required to approve)</span>
        </span>
        <input
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          maxLength={500}
          disabled={!open || busy}
          placeholder="Why it is safe to allow this once"
          className={INPUT_CLASS}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={!open || busy}
          onClick={() => void decide('deny')}
          className={buttonClass('deny', h)}
        >
          <Icon name="x" size={15} />
          Deny
        </button>
        <button
          type="button"
          disabled={!open || busy || reason.trim().length < MIN_REASON}
          onClick={() => void decide('approve')}
          className={buttonClass('secondary', h)}
        >
          Approve once
        </button>
        <span className="text-xs text-muted-foreground sm:ml-auto">
          Recorded in the audit ledger
        </span>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-[12.5px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
