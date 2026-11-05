/* Presentational values (ring radii, poll interval) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Kill dialog (design 3a): blast radius as nested rings, typed confirmation of the run's short id, then the measured
// halt. Only the run scope is live in the POC; asset, organisation and global are drawn disabled.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { buttonClass, Icon, INPUT_CLASS } from './design';
import { Modal } from './modal';
import { killConfirmed, shortId } from './run-model';

const POLL_MS = 500;
const NO_EVENTS = 1_000_000;

type Phase = 'form' | 'halting' | 'halted';

const SCOPES = [
  { label: 'This run', live: true },
  { label: 'This asset', live: false },
  { label: 'Entire organisation', live: false },
  { label: 'Everything', live: false },
] as const;

const STEPS = ['Agent aborted', 'Pending Gate 2 denied', 'Target egress blocked'] as const;

export function KillButton({
  run,
  className,
}: {
  readonly run: { readonly id: string; readonly assetName: string } | null;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={run === null}
        onClick={() => {
          setOpen(true);
        }}
        className={buttonClass('kill', className ?? 'h-9 px-4')}
      >
        <Icon name="kill" size={16} />
        {className === undefined ? 'Kill' : 'Kill run'}
      </button>
      {run === null ? null : (
        <KillDialog
          run={run}
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
      <div className="grid md:grid-cols-[300px_minmax(0,1fr)]">
        <div className="hidden items-center justify-center bg-surface-2 p-8 md:flex">
          <svg viewBox="0 0 240 240" className="w-full max-w-[240px]" aria-hidden="true">
            <circle
              cx="120"
              cy="120"
              r="118"
              style={{ fill: 'var(--card)', stroke: 'var(--border-strong)' }}
            />
            <circle
              cx="120"
              cy="120"
              r="84"
              style={{
                fill: 'var(--kill-soft)',
                stroke: 'var(--kill)',
                strokeWidth: 1.5,
                opacity: 0.5,
              }}
            />
            <circle
              cx="120"
              cy="120"
              r="44"
              style={{ fill: 'var(--kill-soft)', stroke: 'var(--kill)', strokeWidth: 2 }}
            />
          </svg>
        </div>
        <div className="flex flex-col gap-4 p-6">
          <h2 className="flex items-center gap-2.5 text-xl font-semibold">
            <Icon name="kill" size={24} className="text-kill" />
            Stop testing
          </h2>
          {phase === 'form' ? (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Blast radius</legend>
                {SCOPES.map((s) => (
                  <label
                    key={s.label}
                    className={`flex items-center gap-3 rounded-xl border p-3 text-[13px] ${s.live ? 'border-kill bg-kill-soft' : 'border-border opacity-50'}`}
                  >
                    <input
                      type="radio"
                      name="scope"
                      checked={s.live}
                      disabled={!s.live}
                      readOnly
                      className="accent-[var(--kill)]"
                    />
                    <span className="flex flex-col">
                      <span className="font-semibold">{s.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.live
                          ? `${run.assetName}, run_${shortId(run.id)}`
                          : 'Not available in the POC'}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="text-[12.5px] leading-5 text-muted-foreground">
                The agent is aborted at once, pending Gate 2 requests are denied and no further
                request reaches the target.
              </p>
              <label className="flex flex-col gap-1.5 text-[12.5px] font-medium">
                <span>
                  Type{' '}
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{expected}</code>{' '}
                  to confirm
                </span>
                <input
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                  }}
                  placeholder={expected}
                  autoComplete="off"
                  className={`${INPUT_CLASS} font-mono`}
                />
              </label>
              {error === null ? null : (
                <p role="alert" className="text-[12.5px] text-bad">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-end gap-2.5">
                <span className="mr-auto text-xs text-muted-foreground">
                  Recorded in the run log
                </span>
                <button type="button" onClick={onClose} className={buttonClass('secondary')}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!killConfirmed(typed, run.id)}
                  onClick={() => void stop()}
                  className={buttonClass('kill')}
                >
                  Stop now
                </button>
              </div>
            </>
          ) : (
            <>
              <ul className="flex flex-col gap-2" aria-live="polite">
                {STEPS.map((step) => (
                  <li
                    key={step}
                    className="flex items-center gap-2.5 rounded-lg border border-border p-3 text-[13px]"
                  >
                    {phase === 'halted' ? (
                      <Icon name="check" size={16} className="text-ok" />
                    ) : (
                      <span className="size-4 rounded-full border-2 border-border-strong border-t-primary motion-safe:animate-spin" />
                    )}
                    {step}
                  </li>
                ))}
              </ul>
              <p className="rounded-lg bg-surface-2 p-3 font-mono text-[12.5px]">
                {phase === 'halted'
                  ? `run.killed  run_${shortId(run.id)}  halt ${haltMs === null ? 'not recorded' : `${haltMs} ms`}`
                  : 'Waiting for the worker to confirm the halt...'}
              </p>
              {phase === 'halted' ? (
                <div className="flex justify-end">
                  <button type="button" onClick={onClose} className={buttonClass('secondary')}>
                    Close
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
