'use client';

// Gate 3 on one finding (experience spec §6.3): `Release to report` (gold, key R) and `Dismiss…` (reason required).
// A proven finding is released with the reason "Proven by replay", which the person can change first; a kept-back
// finding needs its own reason. Decisions wait for the server (they must be true); the action's response carries the
// refreshed page. Esc closes a reason form.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import { triageFindingAction } from '../../../app/(console)/findings/actions';
import { reasonEnough } from '../../../lib/normalize';
import { buttonClass, Icon, InlineMessage } from '../design';
import { PendingButton, ReasonField } from '../design-client';
import { LocalTime } from './local-time';

import type { FindingDetail } from './model';

// Every PendingButton here passes stayPending and returns false: it then runs the action and resets once it settles.
export const PROVEN_REASON = 'Proven by replay';
const HTTP_CONFLICT = 409;
const COPIED_MS = 1600;
const DISMISS_SUGGESTIONS = ['Not exploitable here', 'Accepted risk, tracked', 'Duplicate of another issue'];

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
export function Decided({ finding, viewerName }: { readonly finding: FindingDetail; readonly viewerName: string }) {
  if (finding.status !== 'released' && finding.status !== 'dismissed') return null;
  const t = finding.triage;
  const released = finding.status === 'released';
  const by = t?.by ?? null;
  const who = by === null ? (released ? 'automatically, as chosen on the plan' : '') : `by ${by === viewerName ? 'you' : by}`;
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
          : 'It stays off the report. The decision and its reason are on the ledger.'}
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
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}</span>
    </button>
  );
}

export function TriageControls({
  finding,
  viewerName,
  onDone,
  bindRelease,
  trailing,
}: {
  readonly finding: FindingDetail;
  readonly viewerName: string;
  readonly onDone: (updated: FindingDetail | null) => void;
  /** The page binds the R key to this finding's release while it is open. */
  readonly bindRelease?: (release: (() => void) | null) => void;
  /** Secondary actions (copy, details) at the end of the button row. */
  readonly trailing?: ReactNode;
}) {
  const proven = finding.status === 'confirmed';
  const [mode, setMode] = useState<'idle' | 'release' | 'dismiss'>('idle');
  const [reason, setReason] = useState(proven ? PROVEN_REASON : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'release' | 'dismiss', why: string): Promise<boolean> {
    if (!reasonEnough(why)) {
      setError('Give a reason of at least 8 characters. It is kept on the ledger.');
      return false;
    }
    setError(null);
    setBusy(true);
    const result = await triageFindingAction(finding.id, decision, why);
    setBusy(false);
    if (!result.ok && result.status !== HTTP_CONFLICT) {
      setError(result.message);
      return false;
    }
    // 409: someone already decided; refreshing shows their decision.
    onDone(result.ok ? result.data : null);
    setMode('idle');
    announceChange();
    return true;
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

  if (!canRelease && !canDismiss)
    return (
      <div className="flex flex-col gap-2.5">
        <Decided finding={finding} viewerName={viewerName} />
        {trailing === undefined ? null : <div className="flex flex-wrap gap-1">{trailing}</div>}
      </div>
    );

  if (mode !== 'idle') {
    const release = mode === 'release';
    return (
      <div
        onKeyDown={escapeCloses(cancel)}
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2/60 p-3.5"
      >
        <ReasonField
          label={release ? 'Why release it to the report?' : 'Why dismiss it?'}
          value={reason}
          onChange={setReason}
          autoFocus
          suggestions={release ? (proven ? [PROVEN_REASON] : []) : DISMISS_SUGGESTIONS}
          onSubmit={() => {
            void decide(mode, reason);
          }}
          rows={2}
        />
        {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
        <div className="flex flex-wrap items-center gap-2">
          <PendingButton
            variant={release ? 'primary' : 'deny'}
            pendingLabel={release ? 'Releasing…' : 'Dismissing…'}
            disabled={!reasonEnough(reason)}
            stayPending
            onAction={async () => {
              await decide(mode, reason);
              return false;
            }}
          >
            {release ? 'Release to report' : 'Dismiss'}
          </PendingButton>
          <button
            type="button"
            className={buttonClass('ghost')}
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Decided finding={finding} viewerName={viewerName} />
      <div className="flex flex-wrap items-center gap-2">
        {canRelease ? (
          <PendingButton
            variant="primary"
            icon="check"
            {...(bindRelease === undefined ? {} : { shortcut: 'R' })}
            pendingLabel="Releasing…"
            className="h-11 px-5"
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
            className={buttonClass('secondary', 'h-11 px-4')}
            onClick={() => {
              setMode('dismiss');
              setReason('');
            }}
          >
            Dismiss…
          </button>
        ) : null}
        {trailing === undefined ? null : <span className="ml-auto flex flex-wrap items-center gap-1">{trailing}</span>}
      </div>
      {proven ? (
        <p className="m-0 text-[12px] text-muted-foreground">
          Will be released with the reason &ldquo;{reason}&rdquo; and kept on the ledger with your name.{' '}
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
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (e.key.toLowerCase() !== 'r' || e.ctrlKey || e.metaKey || e.altKey || release.current === null) return;
      if (t !== null && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
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
export function FindingTriage({ finding, viewerName }: { readonly finding: FindingDetail; readonly viewerName: string }) {
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
