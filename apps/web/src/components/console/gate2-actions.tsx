/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Gate 2 actions (experience spec §6.2): Deny is ink, has the default focus and the D key; "Allow for this run…" (A)
// reveals the reason field, and Allow enables at 8 non-space characters (Ctrl/Cmd+Enter submits). Decisions wait for
// the server, because they must be true. A 409 from another tab or person comes back as the decided request, so the
// card shows the receipt instead of an error.
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { buttonClass, Icon, InlineMessage } from './design';
import { clockLabel, PendingButton, ReasonField, useCountdown } from './design-client';
import { secondsLeft } from './run-model';
import { useNow } from './use-now';
import { reasonEnough } from '../../lib/normalize';
import { gate2DetailSchema } from '../../lib/schemas';

export type Gate2Detail = z.infer<typeof gate2DetailSchema>;

export const FOOTNOTE =
  'Allowing lets this method, path and role through until the run ends. No answer means denied. Other agents keep working.';

const answerSchema = gate2DetailSchema.extend({ alreadyDecided: z.boolean().optional() });
const problemSchema = z.object({ message: z.string().optional() }).loose();

type Decision = { ok: true; gate2: Gate2Detail } | { ok: false; message: string | null };

async function postDecision(id: string, decision: 'approve' | 'deny', reason: string): Promise<Decision> {
  try {
    const res = await fetch(`/api/gate2/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const parsed = answerSchema.safeParse(json);
      if (parsed.success) return { ok: true, gate2: parsed.data };
    }
    const problem = problemSchema.safeParse(json);
    return { ok: false, message: res.status >= 500 || !problem.success ? null : (problem.data.message ?? null) };
  } catch {
    return { ok: false, message: null };
  }
}

/** Only the first open decision card on the page (in document order, and visible) answers the D and A keys. */
function ownsKeys(root: HTMLElement | null): boolean {
  if (root === null || root.getClientRects().length === 0) return false;
  const first = [...document.querySelectorAll<HTMLElement>('[data-gate2-open]')].find((el) => el.getClientRects().length > 0);
  return first === root;
}

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * The decision buttons. `layout="column"` is the card's right column; `"sheet"` is the phone's sticky footer
 * (56 px Deny). `onDecided` gets the decided request (from this tab, or from whoever decided first).
 */
export function Gate2Actions({
  gate2Id,
  deadlineAt,
  createdAt,
  layout,
  focusDeny,
  onDecided,
}: {
  readonly gate2Id: string;
  readonly deadlineAt: string;
  readonly createdAt?: string | undefined;
  readonly layout: 'column' | 'sheet';
  /** Focus Deny on mount (the full page always; inline cards only when nothing else has focus). */
  readonly focusDeny: 'always' | 'if-idle';
  readonly onDecided: (gate2: Gate2Detail) => void;
}) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const denyWrap = useRef<HTMLDivElement>(null);
  const allowWrap = useRef<HTMLDivElement>(null);
  const [allowing, setAllowing] = useState(false);
  const [reason, setReason] = useState('');
  const [failed, setFailed] = useState<string | null | false>(false);
  const clock = useCountdown(deadlineAt, createdAt);
  const enough = reasonEnough(reason);

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    setFailed(false);
    const result = await postDecision(gate2Id, decision, decision === 'approve' ? reason : '');
    if (!result.ok) {
      setFailed(result.message);
      return;
    }
    onDecided(result.gate2);
    window.dispatchEvent(new Event('bw:refresh'));
    router.refresh();
  };

  useEffect(() => {
    const deny = denyWrap.current?.querySelector('button');
    if (deny === undefined || deny === null) return;
    const active = document.activeElement;
    if (focusDeny === 'always' || active === null || active === document.body) deny.focus({ preventScroll: true });
  }, [focusDeny]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !ownsKeys(root.current)) return;
      const key = e.key.toLowerCase();
      if (key === 'd') {
        e.preventDefault();
        denyWrap.current?.querySelector('button')?.click();
      } else if (key === 'a') {
        e.preventDefault();
        setAllowing(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const sheet = layout === 'sheet';
  const left = clock === null ? null : clockLabel(clock.secondsLeft);
  const error =
    failed === false ? null : (
      <InlineMessage tone="bad">
        {failed === null ? "Couldn't record your decision." : `Couldn't record your decision: ${failed}`} It&apos;s still
        open{left === null ? '' : `, with ${left} left`}. Retry
      </InlineMessage>
    );

  return (
    <div
      ref={root}
      data-gate2-open=""
      className={`flex flex-col ${sheet ? 'gap-2.5' : 'gap-2'}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && allowing) {
          e.stopPropagation();
          setAllowing(false);
          denyWrap.current?.querySelector('button')?.focus();
        }
      }}
    >
      {allowing ? (
        <ReasonField
          label="Reason (needed to allow)"
          value={reason}
          onChange={setReason}
          onSubmit={() => {
            if (enough) allowWrap.current?.querySelector('button')?.click();
          }}
          placeholder="Why is it safe to send this once?"
          autoFocus
          rows={sheet ? 2 : 3}
        />
      ) : null}
      <div ref={denyWrap} className="contents">
        <PendingButton
          variant="deny"
          pendingLabel="Denying…"
          onAction={() => decide('deny')}
          className={
            sheet
              ? 'h-14 w-full rounded-[14px] text-base'
              : 'h-11 w-full justify-between shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--gold-ink)]'
          }
          shortcut={sheet ? undefined : 'D'}
        >
          <span className="inline-flex items-center gap-2">
            <Icon name="x" size={sheet ? 18 : 15} />
            Deny
          </span>
        </PendingButton>
      </div>
      {allowing ? (
        <div className={`flex gap-2 ${sheet ? 'flex-col' : 'flex-col'}`}>
          <div ref={allowWrap} className="contents">
            <PendingButton
              variant="primary"
              pendingLabel="Allowing…"
              disabled={!enough}
              title={enough ? undefined : 'Write a reason of at least 8 characters first'}
              onAction={() => decide('approve')}
              className={sheet ? 'h-12 w-full rounded-[14px] text-[14px]' : 'h-11 w-full'}
            >
              Allow for this run
            </PendingButton>
          </div>
          <button
            type="button"
            onClick={() => {
              setAllowing(false);
            }}
            className={buttonClass('ghost', sheet ? 'h-11 w-full' : 'h-9 w-full text-[12.5px]')}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setAllowing(true);
          }}
          className={buttonClass(
            'secondary',
            sheet ? 'h-12 w-full rounded-[14px] text-[14px]' : 'h-11 w-full justify-between',
          )}
        >
          {sheet ? 'Allow for this run, with a reason' : 'Allow for this run…'}
          {sheet ? null : (
            <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-current px-1 font-mono text-[10.5px] font-medium leading-none opacity-60">
              A
            </kbd>
          )}
        </button>
      )}
      {error}
      <p className={`m-0 text-[11px] leading-4 text-muted-foreground ${sheet ? 'text-center text-[11.5px]' : ''}`}>
        {FOOTNOTE}
      </p>
    </div>
  );
}

/** Seconds left and the full window of a Gate 2 request (used by the run view's banner). */
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
      : Math.max(1, Math.round((new Date(deadlineAt).getTime() - new Date(createdAt).getTime()) / 1000));
  const left = pending && !mounted ? initialLeft : live;
  return { left, total: Math.max(total, left, 1) };
}

/**
 * shortcut: the old transcript's buttons, kept only until the live view renders Gate2Card (group B); delete then.
 */
export function Gate2Buttons({ gate2Id, open }: { readonly gate2Id: string; readonly open: boolean }) {
  const router = useRouter();
  if (!open) return null;
  return (
    <a href={`/decisions/gate2/${encodeURIComponent(gate2Id)}`} onClick={(e) => {
      e.preventDefault();
      router.push(`/decisions/gate2/${encodeURIComponent(gate2Id)}`);
    }} className={buttonClass('primary', 'h-10')}>
      Decide
    </a>
  );
}
