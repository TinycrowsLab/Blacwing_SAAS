/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Emergency stop page (design 3b): dark, full screen, no login. One red button that must be held for 1.5 s (a ring
// fills; letting go early cancels; Space or Enter held works the same), then the halt of each audit it reached.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { buttonClass, Icon } from './design';
import { haltAction, stopAllAction } from '../../app/emergency/[token]/actions';

import type { EmergencyContact, EmergencyRun } from '../../lib/schemas';

const HOLD_MS = 1500;
const POLL_MS = 1500;
/** Stop polling after this long; the page then says the runner is still halting. */
const POLL_FOR_MS = 60_000;
const ENDED = new Set(['killed', 'completed', 'failed']);
const RING = { size: 240, stroke: 8 };
const RADIUS = (RING.size - RING.stroke) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** "2026-10-21 06:00 UTC": the same wherever the link is opened. */
const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const audits = (n: number): string => (n === 1 ? '1 audit' : `${n.toLocaleString()} audits`);

/** The dark full-screen canvas with the Blackwing mark. */
export function EmergencyFrame({ children, badge = false }: { readonly children: ReactNode; readonly badge?: boolean }) {
  return (
    <div className="dark min-h-dvh bg-bg text-foreground">
      <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-6 pb-8 pt-6">
        <header className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2.5">
            <img src="/brand/crow-shield.png" alt="" width={28} height={28} className="object-contain" />
            <span className="text-[17px] font-semibold">Blackwing</span>
          </span>
          {badge ? <span className="text-[13px] text-muted-foreground">Emergency stop</span> : null}
        </header>
        {children}
      </main>
    </div>
  );
}

/** The expired-link page and its kin: no detail about the link, only the workspace's own contact when one is set. */
export function EmergencyNotice({
  eyebrow,
  title,
  children,
  contact,
  retry = false,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly contact: EmergencyContact | null;
  readonly retry?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 pt-14">
      <p className="m-0 text-[13px] font-semibold text-warn">{eyebrow}</p>
      <h1 className="m-0 text-[30px] font-semibold leading-[38px] tracking-[-0.01em]">{title}</h1>
      <p className="m-0 text-[15px] leading-6 text-muted-foreground">{children}</p>
      {contact === null ? null : (
        <a
          href={`tel:${contact.phone.replace(/[^+0-9]/g, '')}`}
          className="mt-3 flex flex-col items-center gap-0.5 rounded-[14px] bg-foreground px-4 py-3.5 text-center text-background focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          <span className="text-[16px] font-semibold">Emergency contact</span>
          <span className="text-[13.5px]">
            {contact.name}, {contact.phone}
          </span>
        </a>
      )}
      {retry ? (
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className={buttonClass('secondary', 'mt-3 h-12 justify-center')}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

type Phase =
  | { readonly kind: 'ready' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent'; readonly at: string; readonly runs: readonly EmergencyRun[]; readonly hash: string | null }
  | { readonly kind: 'failed'; readonly message: string; readonly expired: boolean };

export function EmergencyStop({
  token,
  workspace,
  liveRuns,
  label,
  expiresAt,
}: {
  readonly token: string;
  readonly workspace: string | null;
  readonly liveRuns: number;
  readonly label: string | null;
  readonly expiresAt: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const started = useRef<number | null>(null);
  const frame = useRef(0);

  async function fire(): Promise<void> {
    setPhase({ kind: 'sending' });
    const r = await stopAllAction(token);
    if (r.ok) setPhase({ kind: 'sent', at: r.data.stoppedAt, runs: r.data.runs, hash: r.data.hash });
    else
      setPhase({
        kind: 'failed',
        expired: r.code === 'emergency_link_expired',
        message: r.code === 'emergency_link_expired' ? 'This emergency link has expired. Nothing was stopped.' : r.message,
      });
  }

  function tick(): void {
    if (started.current === null) return;
    const p = Math.min(1, (performance.now() - started.current) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      started.current = null;
      void fire();
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }

  function begin(): void {
    if (phase.kind !== 'ready' || started.current !== null) return;
    setHint(false);
    started.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  }

  function cancel(): void {
    if (started.current === null) return;
    started.current = null;
    cancelAnimationFrame(frame.current);
    setProgress(0);
    setHint(true);
  }

  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
  }, []);

  // After the stop: read each audit's halt until all have ended (the runner halts a running audit within seconds).
  const pending = phase.kind === 'sent' && phase.runs.some((r) => !ENDED.has(r.state));
  // Keyed on the stop itself, not on each poll's update, so the time limit counts from the stop.
  const runIds = phase.kind === 'sent' ? phase.runs.map((r) => r.id).join(',') : '';
  useEffect(() => {
    if (!pending) return;
    const ids = runIds.split(',');
    const since = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - since > POLL_FOR_MS) {
        window.clearInterval(timer);
        setGaveUp(true);
        return;
      }
      void haltAction(token, ids).then((r) => {
        if (!r.ok) return;
        const next = new Map(r.data.map((run) => [run.id, run]));
        setPhase((old) => (old.kind === 'sent' ? { ...old, runs: old.runs.map((run) => next.get(run.id) ?? run) } : old));
      });
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [pending, runIds, token]);

  if (phase.kind === 'sent') return <Halted phase={phase} pending={pending} gaveUp={gaveUp} />;

  const holding = progress > 0 && phase.kind === 'ready';
  const busy = phase.kind === 'sending';
  return (
    <EmergencyFrame badge>
      <div className="flex flex-col gap-3 pt-8">
        <h1 className="m-0 text-[30px] font-semibold leading-[38px] tracking-[-0.01em]">
          {workspace === null ? (
            'Stop all testing'
          ) : (
            <>
              Stop all testing for <span className="block text-gold-ink">{workspace}</span>
            </>
          )}
        </h1>
        <p className="m-0 text-[15px] leading-6 text-muted-foreground">
          {liveRuns === 0
            ? 'No audit is running right now.'
            : `${audits(liveRuns)} ${liveRuns === 1 ? 'is' : 'are'} running right now. Every agent halts and nothing new is sent.`}
        </p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10">
        <div className="relative" style={{ width: RING.size, height: RING.size }}>
          <svg
            aria-hidden="true"
            width={RING.size}
            height={RING.size}
            viewBox={`0 0 ${RING.size} ${RING.size}`}
            className="absolute inset-0 -rotate-90"
          >
            <circle cx={RING.size / 2} cy={RING.size / 2} r={RADIUS} fill="none" strokeWidth={RING.stroke} className="stroke-kill-soft" />
            <circle
              cx={RING.size / 2}
              cy={RING.size / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={RING.stroke}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - (busy ? 1 : progress))}
              className="stroke-foreground"
              style={{ transition: progress === 0 ? 'stroke-dashoffset 200ms ease-out' : 'none' }}
            />
          </svg>
          <button
            type="button"
            disabled={busy}
            aria-describedby="hold-help"
            aria-busy={busy || undefined}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              begin();
            }}
            onPointerUp={cancel}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onKeyDown={(e) => {
              if (e.key !== ' ' && e.key !== 'Enter') return;
              e.preventDefault();
              if (!e.repeat) begin();
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') cancel();
            }}
            onBlur={cancel}
            onContextMenu={(e) => {
              e.preventDefault();
            }}
            className={`absolute inset-[18px] flex touch-none select-none flex-col items-center justify-center gap-2 rounded-full bg-kill text-on-kill shadow-[0_0_0_6px_var(--kill-soft)] [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-[4px] focus-visible:ring-focus disabled:cursor-wait motion-safe:transition-transform ${holding ? 'scale-[0.97]' : ''}`}
          >
            {busy ? (
              <span aria-hidden="true" className="size-8 rounded-full border-[3px] border-current border-t-transparent motion-safe:animate-[bwspin_0.8s_linear_infinite]" />
            ) : (
              <Icon name="kill" size={30} />
            )}
            <span className="px-6 text-center text-[19px] font-bold uppercase leading-6 tracking-[0.01em]">
              {busy ? 'Stopping…' : 'Stop all testing now'}
            </span>
          </button>
        </div>
        <p aria-live="polite" className="m-0 min-h-5 text-center text-[13px] text-muted-foreground">
          {phase.kind === 'failed'
            ? null
            : holding
              ? 'Keep holding…'
              : hint
                ? 'Keep holding until the ring is full.'
                : null}
        </p>
        {phase.kind === 'failed' ? (
          <div role="alert" className="flex w-full flex-col items-center gap-3 text-center">
            <p className="m-0 text-[14px] text-bad">{phase.message}</p>
            {phase.expired ? null : (
              <button
                type="button"
                onClick={() => {
                  setPhase({ kind: 'ready' });
                  setProgress(0);
                }}
                className={buttonClass('secondary', 'h-11 justify-center px-5')}
              >
                Try again
              </button>
            )}
          </div>
        ) : null}
      </div>

      <footer className="flex flex-col items-center gap-1.5 text-center">
        <p id="hold-help" className="m-0 text-[15px] font-semibold">
          Press and hold for 1.5 seconds
        </p>
        <p className="m-0 text-[12.5px] leading-5 text-muted-foreground">
          {label === null ? 'Link' : `Link issued to ${label},`} valid until {utc(expiresAt)}
        </p>
      </footer>
    </EmergencyFrame>
  );
}

function Halted({
  phase,
  pending,
  gaveUp,
}: {
  readonly phase: Extract<Phase, { kind: 'sent' }>;
  readonly pending: boolean;
  readonly gaveUp: boolean;
}) {
  const n = phase.runs.length;
  return (
    <EmergencyFrame badge>
      <div className="flex flex-col gap-3 pt-8">
        <span
          className={`flex size-12 items-center justify-center rounded-full ${pending ? 'bg-kill-soft text-kill' : 'bg-ok-soft text-ok'}`}
        >
          <Icon name={pending ? 'kill' : 'check'} size={24} />
        </span>
        <h1 className="m-0 text-[30px] font-semibold leading-[38px] tracking-[-0.01em]">
          {pending ? 'Stopping…' : 'Testing stopped'}
        </h1>
        <p className="m-0 text-[15px] leading-6 text-muted-foreground" aria-live="polite">
          {n === 0
            ? 'No audit was running. Nothing is testing now.'
            : pending
              ? gaveUp
                ? 'The stop is recorded. The runner is still halting; requests already on the wire may finish, nothing new is sent.'
                : `Halting ${audits(n)}. Requests already on the wire may finish; nothing new is sent.`
              : `${n === 1 ? 'The audit has' : `All ${audits(n)} have`} halted. Findings so far are kept.`}
        </p>
      </div>
      {n === 0 ? null : (
        <ul className="m-0 mt-6 flex list-none flex-col gap-2.5 p-0">
          {phase.runs.map((run) => {
            const ended = ENDED.has(run.state);
            return (
              <li
                key={run.id}
                className="flex items-center justify-between gap-3 rounded-[14px] border border-border bg-card px-4 py-3"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] font-semibold">{run.assetName}</span>
                  <span className="font-mono text-[12px] text-muted-foreground">Run {run.shortId}</span>
                </span>
                {ended ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-ok">
                    <Icon name="check" size={15} />
                    {run.haltMs === null ? 'Stopped' : `Stopped in ${run.haltMs.toLocaleString()} ms`}
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="size-3.5 rounded-full border-2 border-border-strong border-t-gold-ink motion-safe:animate-[bwspin_0.8s_linear_infinite]"
                    />
                    Stopping…
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <footer className="mt-auto flex flex-col items-center gap-1 pt-10 text-center text-[12.5px] text-muted-foreground">
        <span>
          Stop sent {utc(phase.at)}
          {phase.hash === null ? null : <> · recorded in the ledger <span className="font-mono">{phase.hash.slice(0, 8)}</span></>}
        </span>
      </footer>
    </EmergencyFrame>
  );
}
