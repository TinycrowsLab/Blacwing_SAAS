/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Stop testing (experience spec §6.4): one solid-red component everywhere (run header, sidebar pill, mobile top bar),
// rendered only while a run can be stopped. One confirmation, no typing: the client sends the run's short id itself
// (the API's "you know which run" guard). Then the halt, step by step, from the run's real state.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { buttonClass, Icon, Kbd } from './design';
import { Modal } from './modal';
import { shortId } from './run-model';
import { auditRefSchema } from '../../lib/schemas';

const POLL_MS = 500;
const NO_EVENTS = 1_000_000;

export interface StoppableRun {
  readonly id: string;
  /** The target's name (its host): the dialog asks "Stop testing {assetName}?". */
  readonly assetName: string;
}

const haltSchema = z.object({
  state: z.string(),
  haltMs: z.number().nullable().default(null),
  gate2: z.array(z.object({ status: z.string() })).default([]),
});

/** Opens the Stop dialog for `run`. Renders nothing visible while `run` is null (not queued, running or paused). */
export function KillButton({
  run,
  variant = 'header',
  label,
  className,
  shortcut = false,
  hideTrigger = false,
}: {
  readonly run: StoppableRun | null;
  /** `header`: the run page button; `pill`: the sidebar "1 audit running · Stop"; `icon`: the 44 px mobile button. */
  readonly variant?: 'header' | 'pill' | 'icon';
  /** The pill's text, e.g. "1 audit running". */
  readonly label?: string;
  readonly className?: string;
  /** Ctrl+Shift+. opens the dialog (bind it once per page: the sidebar does). */
  readonly shortcut?: boolean;
  /** Keep the dialog and the shortcut, without a visible trigger (the sidebar on the run's own page). */
  readonly hideTrigger?: boolean;
}) {
  // The run the dialog was opened for: it stays mounted after the halt, when `run` becomes null.
  const [target, setTarget] = useState<StoppableRun | null>(run);
  const [open, setOpen] = useState(false);
  const openFor = (r: StoppableRun): void => {
    setTarget(r);
    setOpen(true);
  };

  useEffect(() => {
    if (!shortcut || run === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Period') {
        e.preventDefault();
        openFor(run);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [shortcut, run]);

  let trigger = null;
  if (run !== null && !hideTrigger) {
    const onClick = (): void => {
      openFor(run);
    };
    if (variant === 'pill')
      trigger = (
        <button
          type="button"
          onClick={onClick}
          className={buttonClass('kill', `h-9 w-full justify-between rounded-full px-3.5 text-[12.5px] ${className ?? ''}`)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-on-kill motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]" />
            <span className="truncate">{label ?? 'Audit running'}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Icon name="kill" size={14} />
            Stop
          </span>
        </button>
      );
    else if (variant === 'icon')
      trigger = (
        <button
          type="button"
          onClick={onClick}
          title="Stop testing"
          className={buttonClass('kill', `size-11 rounded-[10px] px-0 ${className ?? ''}`)}
        >
          <Icon name="kill" size={20} />
          <span className="sr-only">Stop testing</span>
        </button>
      );
    else
      trigger = (
        <button type="button" onClick={onClick} className={buttonClass('kill', className ?? 'h-10 px-4')}>
          <Icon name="kill" size={16} />
          Stop testing
        </button>
      );
  }

  return (
    <>
      {trigger}
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

type Phase = 'confirm' | 'stopping' | 'halted';

function KillDialog({
  run,
  open,
  onClose,
}: {
  readonly run: StoppableRun;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const [halt, setHalt] = useState<z.infer<typeof haltSchema> | null>(null);
  const [audit, setAudit] = useState<{ eventId: string; hash: string } | null>(null);

  async function stop(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'run', confirm: shortId(run.id) }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: unknown;
        code?: unknown;
        killRequestedAt?: unknown;
        audit?: unknown;
      };
      if (!res.ok) {
        setError(
          body.code === 'run_not_running'
            ? 'This audit has already finished. Nothing is running.'
            : typeof body.message === 'string'
              ? body.message
              : "Couldn't reach Blackwing. Nothing was stopped. Try again.",
        );
        return;
      }
      setRequestedAt(typeof body.killRequestedAt === 'string' ? body.killRequestedAt : new Date().toISOString());
      setAudit(auditRefSchema.parse(body.audit ?? null));
      setPhase('stopping');
    } catch {
      setError("Couldn't reach Blackwing. Nothing was stopped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (phase !== 'stopping') return;
    const timer = window.setInterval(() => {
      void (async () => {
        const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}?afterSeq=${NO_EVENTS}`, { cache: 'no-store' });
        if (!res.ok) return;
        const parsed = haltSchema.safeParse(await res.json());
        if (!parsed.success) return;
        setHalt(parsed.data);
        if (['killed', 'completed', 'failed'].includes(parsed.data.state)) {
          setPhase('halted');
          window.dispatchEvent(new Event('bw:refresh'));
          router.refresh();
        }
      })();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase, run.id, router]);

  // The halt view replaces the Stop button: move focus to Close so the keyboard is never lost.
  useEffect(() => {
    if (phase === 'halted') document.querySelector<HTMLElement>('dialog[open] [data-autofocus]')?.focus();
  }, [phase]);

  const time = (iso: string | null): string =>
    iso === null ? '' : new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(iso));
  const halted = phase === 'halted';
  const steps = [
    { label: 'Stop requested', detail: time(requestedAt), done: requestedAt !== null },
    { label: 'Agents halted', detail: halted ? 'No new request is sent' : 'Waiting for the runner…', done: halted },
    {
      label: 'Pending decisions denied',
      detail: halt === null ? '' : `${halt.gate2.filter((g) => g.status !== 'pending').length} of ${halt.gate2.length} closed`,
      done: halted && (halt?.gate2.every((g) => g.status !== 'pending') ?? true),
    },
    {
      label: halt?.haltMs === null || halt?.haltMs === undefined ? 'Halt measured' : `Halt measured in ${halt.haltMs.toLocaleString()} ms`,
      detail: '',
      done: halted && halt?.haltMs !== null,
    },
  ];

  return (
    <Modal open={open} onClose={onClose} label={`Stop testing ${run.assetName}`} className="max-w-[520px]">
      <div className="flex flex-col gap-5 p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-kill-soft text-kill">
            <Icon name="kill" size={20} />
          </span>
          <h2 className="m-0 min-w-0 break-words text-[20px] font-semibold leading-7">
            {phase === 'confirm' ? `Stop testing ${run.assetName}?` : halted ? 'Testing stopped' : 'Stopping…'}
          </h2>
        </div>
        {phase === 'confirm' ? (
          <>
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13.5px] leading-[21px] text-muted-foreground">
              <li>Every agent halts now. Requests already on the wire may finish; nothing new is sent.</li>
              <li>Pending decisions are denied.</li>
              <li>Findings so far are kept.</li>
            </ul>
            <div className="flex items-center gap-3 rounded-xl border-[1.5px] border-kill bg-kill-soft px-3.5 py-3">
              <Icon name="check" size={16} className="text-kill" />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13.5px] font-semibold">This audit</span>
                <span className="truncate text-xs text-muted-foreground">{run.assetName}</span>
              </span>
            </div>
            {error === null ? null : (
              <p role="alert" className="m-0 text-[13px] text-bad">
                {error}
              </p>
            )}
            <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-end">
              <span className="text-xs text-muted-foreground sm:mr-auto">Recorded in the ledger</span>
              <button type="button" onClick={onClose} className={buttonClass('secondary', 'h-11 px-5')}>
                Keep running
              </button>
              <button
                type="button"
                data-autofocus
                disabled={busy}
                onClick={() => void stop()}
                className={buttonClass('kill', 'h-11 px-5 text-[14px]')}
              >
                {busy ? (
                  <span aria-hidden="true" className="size-3.5 rounded-full border-2 border-current border-t-transparent motion-safe:animate-[bwspin_0.8s_linear_infinite]" />
                ) : (
                  <Icon name="kill" size={16} />
                )}
                {busy ? 'Stopping…' : 'Stop testing'}
                <Kbd>Enter</Kbd>
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-live="polite">
              {steps.map((s) => (
                <li key={s.label} className="flex items-center gap-3">
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full ${s.done ? 'bg-ok text-white' : 'border-[1.5px] border-border-strong'}`}
                  >
                    {s.done ? (
                      <Icon name="check" size={13} />
                    ) : (
                      <span className="size-3 rounded-full border-2 border-border-strong border-t-gold-ink motion-safe:animate-[bwspin_0.8s_linear_infinite]" />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13.5px] font-medium">{s.label}</span>
                    {s.detail === '' ? null : <span className="text-xs text-muted-foreground">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <span className="mr-auto text-xs text-muted-foreground">
                Recorded in the ledger
                {audit === null ? null : <span className="font-mono"> · {audit.hash.slice(0, 8)}</span>}
              </span>
              {halted ? (
                <>
                  <Link href="/ledger" onClick={onClose} className={buttonClass('ghost', 'h-10')}>
                    See the ledger
                  </Link>
                  <button type="button" data-autofocus onClick={onClose} className={buttonClass('secondary', 'h-10')}>
                    Close
                  </button>
                </>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
