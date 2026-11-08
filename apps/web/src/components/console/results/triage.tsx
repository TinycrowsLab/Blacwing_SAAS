'use client';

// Gate 3 on one finding (experience spec §6.3): `Release to report` (gold, key R) and `Dismiss…` (reason required).
// A proven finding is released with the reason "Proven by replay", which the person can change first; a kept-back
// finding needs its own reason. Decisions wait for the server (they must be true); the action's response carries the
// refreshed page, and the decision is committed in the same transition, so the issue, the banner and the report card
// change together. Esc closes a reason form; Ctrl+Enter sends it.
import {
  type KeyboardEvent,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';

import { reopenFindingAction, triageFindingAction } from '../../../app/(console)/findings/actions';
import { reasonEnough } from '../../../lib/normalize';
import { buttonClass, Icon, InlineMessage } from '../design';
import { PendingButton, ReasonField } from '../design-client';
import { LocalTime } from './local-time';
import { useNudge } from './nudge';

import type { FindingDetail } from './model';

// Every PendingButton here passes stayPending and returns false: it then runs the action and resets once it settles.
export const PROVEN_REASON = 'Proven by replay';
const HTTP_CONFLICT = 409;
const COPIED_MS = 1600;
const DISMISS_SUGGESTIONS = [
  'Not exploitable here',
  'Accepted risk, tracked',
  'Duplicate of another issue',
];

/** The reason form's footnote: where the reason goes and how to send it without the mouse. */
export const REASON_NOTE = 'Kept on the ledger with your name · Ctrl+Enter to send';

/**
 * Runs a server action as a React transition and resolves once React has committed everything it changed, the
 * refreshed page included. Updates made after the action's `await` go through `startTransition` so they land in the
 * same commit as the page (no row says "Released" while the banner still counts it).
 */
export function useSettledAction(): {
  settling: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
} {
  const [settling, start] = useTransition();
  const nudge = useNudge();
  const waiting = useRef<{ seen: boolean; done: () => void } | null>(null);
  useEffect(() => {
    const w = waiting.current;
    if (w === null) return;
    if (settling) w.seen = true;
    else if (w.seen) {
      waiting.current = null;
      w.done();
    }
  }, [settling]);
  // Stable, so a caller may keep it in an effect's dependencies.
  const run = useCallback(
    (action: () => Promise<void>): Promise<void> =>
      new Promise((resolve) => {
        const w = { seen: false, done: resolve };
        waiting.current = w;
        start(action);
        nudge(() => waiting.current !== w);
      }),
    [nudge],
  );
  return { settling, run };
}

/** Every mutation tells the sidebar to refresh (spec §10.5); the page itself comes back with the action's response. */
export function announceChange(): void {
  window.dispatchEvent(new Event('bw:refresh'));
}

/** Esc inside a reason form closes it (spec §10.4) without reaching page-level shortcuts. */
export function escapeCloses(close: () => void) {
  return (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
}

/** Who decided and when, with the reason: "Dismissed by you · 6 Nov, 09:10 · "Accepted risk, tracked"". */
function Decided({
  finding,
  viewerName,
}: {
  readonly finding: FindingDetail;
  readonly viewerName: string;
}) {
  if (finding.status !== 'released' && finding.status !== 'dismissed') return null;
  const t = finding.triage;
  const released = finding.status === 'released';
  const by = t?.by ?? null;
  const who =
    by === null
      ? released
        ? 'automatically, as chosen on the plan'
        : ''
      : `by ${by === viewerName ? 'you' : by}`;
  return (
    <div className="flex flex-col gap-0.5 text-[13px] leading-5">
      <p className="m-0 text-foreground">
        <span className="font-medium">
          {released ? 'Released' : 'Dismissed'} {who}
        </span>
        <span className="text-muted-foreground">
          {t === null ? null : <LocalTime iso={t.at} style="datetime" prefix=" · " />}
          {t?.reason ? <> · &ldquo;{t.reason}&rdquo;</> : null}
        </span>
      </p>
      <p className="m-0 text-[12.5px] text-muted-foreground">
        {released
          ? 'It is in the report. Dismissing it takes it out again, with a reason.'
          : 'It stays off the report until it is reopened. The decision and its reason are on the ledger.'}
      </p>
    </div>
  );
}

/** Copies text; says so for a moment. */
export function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => {
      setState('idle');
    }, COPIED_MS);
    return () => {
      window.clearTimeout(t);
    };
  }, [state]);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setState('done');
          },
          () => {
            setState('failed');
          },
        );
      }}
      className={buttonClass('ghost', 'h-9 px-3 text-[13px]')}
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} size={14} />
      <span aria-live="polite">
        {state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </span>
    </button>
  );
}

export function TriageControls({
  finding,
  viewerName,
  onDone,
  bindRelease,
  trailing,
  primary = true,
}: {
  readonly finding: FindingDetail;
  readonly viewerName: string;
  readonly onDone: (updated: FindingDetail | null) => void;
  /** The page binds the R key to this finding's release while it is open. */
  readonly bindRelease?: (release: (() => void) | null) => void;
  /** Secondary actions (copy, details) at the end of the button row. */
  readonly trailing?: ReactNode;
  /** Gold only for the one issue in focus (one primary per screen); the other open issues get the outlined button. */
  readonly primary?: boolean;
}) {
  const proven = finding.status === 'confirmed';
  const [mode, setMode] = useState<'idle' | 'release' | 'dismiss' | 'reopen'>('idle');
  const [reason, setReason] = useState(proven ? PROVEN_REASON : '');
  const [error, setError] = useState<string | null>(null);
  const { settling: busy, run } = useSettledAction();

  async function decide(decision: 'release' | 'dismiss' | 'reopen', why: string): Promise<void> {
    if (!reasonEnough(why)) {
      setError('Give a reason of at least 8 characters. It is kept on the ledger.');
      return;
    }
    setError(null);
    await run(async () => {
      const result = decision === 'reopen' ? await reopenFindingAction(finding.id, why) : await triageFindingAction(finding.id, decision, why);
      startTransition(() => {
        if (!result.ok && result.status !== HTTP_CONFLICT) {
          setError(result.message);
          return;
        }
        // 409: someone already decided; the refreshed page shows their decision.
        onDone(result.ok ? result.data : null);
        setMode('idle');
      });
      if (result.ok || result.status === HTTP_CONFLICT) announceChange();
    });
  }

  const canRelease = finding.status === 'confirmed' || finding.status === 'suspected';
  const canDismiss = finding.status !== 'dismissed';
  const quickRelease = (): void => {
    if (proven) void decide('release', reason);
    else setMode('release');
  };
  useEffect(() => {
    if (bindRelease === undefined) return;
    bindRelease(canRelease && mode === 'idle' && !busy ? quickRelease : null);
    return () => {
      bindRelease(null);
    };
  });

  const cancel = (): void => {
    setMode('idle');
    setError(null);
    setReason(proven ? PROVEN_REASON : '');
  };

  if (!canRelease && !canDismiss && mode === 'idle')
    return (
      <div className="flex flex-col gap-2.5">
        <Decided finding={finding} viewerName={viewerName} />
        {finding.status === 'dismissed' ? (
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy}
              className={buttonClass('secondary', 'h-11 px-4')}
              onClick={() => {
                setMode('reopen');
                setReason('');
              }}
            >
              Reopen…
            </button>
          </div>
        ) : null}
        {trailing === undefined ? null : <div className="flex flex-wrap gap-1">{trailing}</div>}
      </div>
    );

  if (mode !== 'idle') {
    const release = mode === 'release';
    const reopen = mode === 'reopen';
    return (
      <div
        onKeyDown={escapeCloses(cancel)}
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2/60 p-3.5"
      >
        <ReasonField
          label={release ? 'Why release it to the report?' : reopen ? 'Why reopen it?' : 'Why dismiss it?'}
          value={reason}
          onChange={setReason}
          autoFocus
          footnote={REASON_NOTE}
          suggestions={release ? (proven ? [PROVEN_REASON] : []) : reopen ? [] : DISMISS_SUGGESTIONS}
          onSubmit={() => {
            void decide(mode, reason);
          }}
          rows={2}
        />
        {release || reopen ? null : (
          <p className="m-0 flex items-start gap-1.5 text-[12.5px] leading-5 text-foreground">
            <Icon name="info" size={14} className="mt-[3px] shrink-0 text-muted-foreground" />A
            dismissal keeps the issue off the report. You can reopen it later, with a reason; both are
            on the ledger.
          </p>
        )}
        {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
        <div className="flex flex-wrap items-center gap-2">
          <PendingButton
            variant={release ? 'primary' : reopen ? 'secondary' : 'deny'}
            pendingLabel={release ? 'Releasing…' : reopen ? 'Reopening…' : 'Dismissing…'}
            disabled={!reasonEnough(reason) || busy}
            stayPending
            onAction={async () => {
              await decide(mode, reason);
              return false;
            }}
          >
            {release ? 'Release to report' : reopen ? 'Reopen' : 'Dismiss for good'}
          </PendingButton>
          <button type="button" className={buttonClass('ghost')} onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Decided finding={finding} viewerName={viewerName} />
      {/* Under 640 px the two decisions share a row in equal halves; the key hint is for keyboards only. */}
      <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
        {canRelease ? (
          <PendingButton
            variant={primary ? 'primary' : 'secondary'}
            icon="check"
            {...(bindRelease === undefined ? {} : { shortcut: 'R' })}
            pendingLabel="Releasing…"
            disabled={busy}
            className={`h-11 px-5 max-sm:px-3 max-sm:[&_kbd]:hidden ${canDismiss ? '' : 'col-span-2'}`}
            stayPending
            onAction={async () => {
              if (proven) await decide('release', reason);
              else setMode('release');
              return false;
            }}
          >
            {proven ? 'Release to report' : 'Review and release…'}
          </PendingButton>
        ) : null}
        {canDismiss ? (
          <button
            type="button"
            disabled={busy}
            className={buttonClass(
              'secondary',
              `h-11 px-4 ${canRelease ? '' : 'col-span-2 justify-self-start'}`,
            )}
            onClick={() => {
              setMode('dismiss');
              setReason('');
            }}
          >
            Dismiss…
          </button>
        ) : null}
        {trailing === undefined ? null : (
          <span className="col-span-2 flex flex-wrap items-center gap-1 sm:ml-auto">
            {trailing}
          </span>
        )}
      </div>
      {proven ? (
        <p className="m-0 text-[12px] text-muted-foreground">
          Will be released with the reason &ldquo;{reason}&rdquo; and kept on the ledger with your
          name.{' '}
          <button
            type="button"
            className="font-medium text-gold-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            onClick={() => {
              setMode('release');
            }}
          >
            Change reason
          </button>
        </p>
      ) : null}
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
    </div>
  );
}

/** Binds R (outside text fields) to whatever release the open finding registers in the returned ref. */
export function useReleaseKey(enabled = true): { current: (() => void) | null } {
  const release = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (
        e.key.toLowerCase() !== 'r' ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        release.current === null
      )
        return;
      if (t !== null && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))
        return;
      e.preventDefault();
      release.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
  return release;
}

/** Gate 3 on the finding detail page: the same controls, with R bound to Release. */
export function FindingTriage({
  finding,
  viewerName,
}: {
  readonly finding: FindingDetail;
  readonly viewerName: string;
}) {
  const release = useReleaseKey();
  return (
    <TriageControls
      finding={finding}
      viewerName={viewerName}
      onDone={() => undefined}
      bindRelease={(fn) => {
        release.current = fn;
      }}
    />
  );
}
