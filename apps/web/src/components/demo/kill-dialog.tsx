/* Presentational values (ring radii, poll interval) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Kill dialog (design 3a): blast radius as nested rings, typed confirmation of the run's short id, then the measured
// halt. Only the run scope is live in the POC; asset, organisation and global are drawn disabled.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { buttonClass, Icon } from './design';
import { Modal } from './modal';
import { auditLine, killConfirmed, shortId } from './run-model';
import { auditRefSchema } from '../../app/demo/_lib/schemas';

const POLL_MS = 500;
const NO_EVENTS = 1_000_000;

type Phase = 'form' | 'halting' | 'halted';

const SCOPES = [
  { label: 'This run', live: true },
  { label: 'This asset', live: false },
  { label: 'Entire organisation', live: false },
] as const;

const HALT_SCALE_MS = 10_000;
const STEPS = [
  { label: 'Agent aborted', target: 'First step', tick: null },
  { label: 'Pending Gate 2 denied', target: 'After the agent', tick: null },
  { label: 'Target egress blocked', target: 'Target under 2 s', tick: 20 },
] as const;

export function KillButton({
  run,
  className,
}: {
  readonly run: { readonly id: string; readonly assetName: string } | null;
  readonly className?: string;
}) {
  // The run the dialog was opened for: it stays mounted after the halt, when `run` becomes null.
  const [target, setTarget] = useState(run);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={run === null}
        onClick={() => {
          setTarget(run);
          setOpen(true);
        }}
        className={buttonClass('kill', className ?? 'h-9 px-4')}
      >
        <Icon name="kill" size={16} />
        <span className={className === undefined ? 'hidden sm:inline' : undefined}>
          {className === undefined ? 'Kill' : 'Kill run'}
        </span>
      </button>
      {target === null ? null : (
        <KillDialog
          key={target.id}
          run={target}
          open={open}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function KillDialog({
  run,
  open,
  onClose,
}: {
  readonly run: { readonly id: string; readonly assetName: string };
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [haltMs, setHaltMs] = useState<number | null>(null);
  const [audit, setAudit] = useState<{ eventId: string; hash: string } | null>(null);
  const expected = run.id.slice(0, 8);

  async function stop() {
    setError(null);
    const res = await fetch(`/demo/api/runs/${encodeURIComponent(run.id)}/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'run', confirm: typed.trim() }),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { message?: unknown };
      setError(typeof problem.message === 'string' ? problem.message : 'Kill was refused.');
      return;
    }
    const answer = auditRefSchema.parse(((await res.json()) as { audit?: unknown }).audit ?? null);
    setAudit(answer);
    setPhase('halting');
  }

  useEffect(() => {
    if (phase !== 'halting') return;
    const timer = window.setInterval(() => {
      void (async () => {
        const res = await fetch(
          `/demo/api/runs/${encodeURIComponent(run.id)}?afterSeq=${NO_EVENTS}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { state?: unknown; haltMs?: unknown };
        if (body.state === 'killed') {
          setHaltMs(typeof body.haltMs === 'number' ? body.haltMs : null);
          setPhase('halted');
          router.refresh();
        }
      })();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase, run.id, router]);

  return (
    <Modal open={open} onClose={onClose} label="Stop testing" className="max-w-[840px]">
      <div className="grid md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="hidden items-center justify-center bg-surface-2 p-6 md:flex">
          <svg
            viewBox="0 0 270 270"
            className="w-full max-w-[270px]"
            role="img"
            aria-label="Blast radius: organisation, asset, run"
          >
            <circle
              cx="135"
              cy="135"
              r="122"
              style={{ fill: 'var(--surface)', stroke: 'var(--border2)' }}
            />
            <circle
              cx="135"
              cy="135"
              r="84"
              style={{ fill: 'var(--surface)', stroke: 'var(--border2)' }}
            />
            <circle
              cx="135"
              cy="135"
              r="44"
              style={{ fill: 'rgba(176, 26, 45, 0.16)', stroke: 'var(--kill)', strokeWidth: 2.5 }}
            />
            {[
              { y: 34, t: 'Organisation, all runs', c: 'var(--muted)' },
              { y: 72, t: run.assetName, c: 'var(--muted)' },
              { y: 139, t: 'This run', c: 'var(--kill)' },
            ].map((l) => (
              <text
                key={l.t}
                x="135"
                y={l.y}
                textAnchor="middle"
                className="text-[11.5px] font-medium"
                style={{ fill: l.c }}
              >
                {l.t}
              </text>
            ))}
          </svg>
        </div>
        <div className="flex flex-col gap-4 p-7">
          <h2 className="flex items-center gap-2.5 text-[22px] font-semibold leading-[30px]">
            <Icon name="kill" size={22} className="text-kill" />
            Stop testing
          </h2>
          {phase === 'form' ? (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Blast radius</legend>
                {SCOPES.map((s) => (
                  <label
                    key={s.label}
                    className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-[13px] ${s.live ? 'border-[1.5px] border-kill bg-[rgba(176,26,45,0.06)]' : 'border border-border'}`}
                  >
                    <input
                      type="radio"
                      name="scope"
                      checked={s.live}
                      disabled={!s.live}
                      readOnly
                      className="size-[18px] shrink-0 accent-[var(--kill)]"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13.5px] font-semibold">{s.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.live
                          ? `${run.assetName}, run_${shortId(run.id)}`
                          : 'Not available in the POC'}
                      </span>
                    </span>
                    {s.live ? (
                      <span className="text-xs font-medium text-muted-foreground">1 run</span>
                    ) : null}
                  </label>
                ))}
              </fieldset>
              <p className="text-[13px] leading-[21px] text-muted-foreground">
                The agent is aborted at once, pending Gate 2 requests are denied and no further
                request reaches the target.
              </p>
              <label className="flex flex-col gap-2 text-[13px] font-medium">
                <span>
                  Type{' '}
                  <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                    {expected}
                  </code>{' '}
                  to confirm
                </span>
                <input
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                  }}
                  placeholder={expected}
                  autoComplete="off"
                  className={`h-11 w-full rounded-[10px] bg-card px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none ${killConfirmed(typed, run.id) ? 'border-[1.5px] border-kill' : 'border border-border-strong'}`}
                />
              </label>
              {error === null ? null : (
                <p role="alert" className="text-[12.5px] text-bad">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-end gap-2.5">
                <span className="mr-auto text-xs text-muted-foreground">
                  Recorded in the audit ledger
                </span>
                <button
                  type="button"
                  onClick={onClose}
                  className={buttonClass('secondary', 'h-11 rounded-[10px]')}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!killConfirmed(typed, run.id)}
                  onClick={() => void stop()}
                  className={buttonClass(
                    'kill',
                    'h-11 rounded-[10px] px-[22px] text-sm font-semibold',
                  )}
                >
                  Stop now
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-end justify-between gap-4">
                <div className="flex flex-col">
                  <span className="text-[13px] font-medium text-muted-foreground">This run</span>
                  <span className="text-2xl font-semibold">
                    {phase === 'halted' ? 'All testing stopped' : 'Stopping now'}
                  </span>
                </div>
                {phase === 'halted' ? (
                  <div className="flex flex-col items-end">
                    <span className="text-xs text-muted-foreground">Total halt time</span>
                    <span className="text-[52px] font-semibold leading-[58px] tabular-nums text-ok">
                      {haltMs === null ? 'not recorded' : `${(haltMs / 1000).toFixed(2)}s`}
                    </span>
                  </div>
                ) : null}
              </div>
              <ul className="flex flex-col gap-3.5" aria-live="polite">
                {STEPS.map((step) => (
                  <li
                    key={step.label}
                    className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 md:grid-cols-[28px_230px_minmax(0,1fr)]"
                  >
                    <span
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full ${phase === 'halted' ? 'bg-ok text-on-primary' : 'border-[1.5px] border-border-strong'}`}
                    >
                      {phase === 'halted' ? (
                        <Icon name="check" size={16} />
                      ) : (
                        <span className="size-4 rounded-full border-2 border-border-strong border-t-primary motion-safe:animate-[bwspin_0.8s_linear_infinite]" />
                      )}
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-semibold">{step.label}</span>
                      <span className="text-xs text-muted-foreground">{step.target}</span>
                    </span>
                    <span className="relative col-start-2 h-2.5 rounded-full bg-surface-2 md:col-start-auto">
                      <span
                        className={`absolute inset-y-0 left-0 rounded-full ${phase === 'halted' ? 'bg-ok' : 'bg-primary'}`}
                        style={{
                          width:
                            phase === 'halted'
                              ? `${Math.min(100, ((haltMs ?? HALT_SCALE_MS) / HALT_SCALE_MS) * 100)}%`
                              : '8%',
                        }}
                      />
                      {step.tick === null ? null : (
                        <span
                          className="absolute -inset-y-0.5 w-0.5 bg-border-strong"
                          style={{ left: `${step.tick}%` }}
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-3 border-t border-border pt-4">
                <span className="mr-auto font-mono text-xs text-muted-foreground">
                  {phase === 'halted'
                    ? `run.killed  run_${shortId(run.id)}  ${auditLine(audit)}`
                    : 'Waiting for the worker to confirm the halt. Recording to audit ledger'}
                </span>
                {phase === 'halted' ? (
                  <>
                    <button
                      type="button"
                      onClick={onClose}
                      className={buttonClass('secondary', 'h-11 rounded-[10px]')}
                    >
                      Close
                    </button>
                    <Link
                      href="/demo/audit"
                      className={buttonClass('primary', 'h-11 rounded-[10px]')}
                    >
                      View audit event
                    </Link>
                  </>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
