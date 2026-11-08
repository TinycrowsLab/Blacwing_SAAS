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
  /** The target's name: the dialog asks "Stop testing {assetName}?". */
  readonly assetName: string;
  /** When it started, so two audits of one target can be told apart. */
  readonly startedAt?: string | null;
  /** Who started it (the picker names them); null or absent when unknown. */
  readonly startedBy?: string | null;
  /** The viewer started it ("Stop all of mine"). */
  readonly mine?: boolean;
}

const haltSchema = z.object({
  state: z.string(),
  haltMs: z.number().nullable().default(null),
  gate2: z.array(z.object({ status: z.string(), decidedAt: z.string().nullable().default(null) })).default([]),
});
type Halt = z.infer<typeof haltSchema>;
/** Clock skew allowed between the browser's "now" and the server's decision times. */
const SKEW_MS = 1000;
const ENDED = ['killed', 'completed', 'failed'];

/**
 * Opens the Stop dialog. On an audit's own page `run` is that audit (Enter stops it). Elsewhere `choices` are the live
 * audits: the dialog lists them with who started each and when, nothing preselected, plus "Stop all of mine". Renders
 * nothing visible while there is nothing to stop.
 */
export function KillButton({
  run,
  choices = [],
  variant = 'header',
  label,
  className,
  shortcut = false,
  hideTrigger = false,
}: {
  readonly run: StoppableRun | null;
  /** Off an audit's page (run null): the live audits to pick from. */
  readonly choices?: readonly StoppableRun[];
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
  // What the dialog was opened for: it stays mounted after the halt, when `run` becomes null.
  const [target, setTarget] = useState<StoppableRun | 'pick' | null>(run);
  const [open, setOpen] = useState(false);
  const can = run !== null || choices.length > 0;
  const openNow = (): void => {
    setTarget(run ?? 'pick');
    setOpen(true);
  };

  useEffect(() => {
    if (!shortcut || !can) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Period') {
        e.preventDefault();
        openNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  let trigger = null;
  if (can && !hideTrigger) {
    const onClick = openNow;
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
          className={buttonClass('kill', `h-11 w-11 rounded-[10px] px-0 ${className ?? ''}`)}
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
          key={target === 'pick' ? 'pick' : target.id}
          runs={target === 'pick' ? choices : [target]}
          pick={target === 'pick'}
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

interface KillAnswer {
  readonly run: StoppableRun;
  readonly ok: boolean;
  readonly message: string;
  readonly killRequestedAt: string | null;
  readonly audit: unknown;
}

const UNREACHABLE = "Couldn't reach Blackwing. Nothing was stopped. Try again.";

async function postKill(run: StoppableRun): Promise<KillAnswer> {
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
    return {
      run,
      ok: res.ok,
      message:
        body.code === 'run_not_running'
          ? 'This audit has already finished. Nothing is running.'
          : typeof body.message === 'string'
            ? body.message
            : UNREACHABLE,
      killRequestedAt: typeof body.killRequestedAt === 'string' ? body.killRequestedAt : null,
      audit: body.audit ?? null,
    };
  } catch {
    return { run, ok: false, message: UNREACHABLE, killRequestedAt: null, audit: null };
  }
}

const time = (iso: string | null | undefined): string =>
  iso === null || iso === undefined ? '' : new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso));

/** "Run 01A1B9 · started 10:31 by Avery": the line that tells two audits of one target apart. */
function runLine(run: StoppableRun, seconds = false): string {
  const at = run.startedAt === undefined || run.startedAt === null ? '' : ` · started ${seconds ? new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(run.startedAt)) : time(run.startedAt)}`;
  const by = run.mine === true ? ' by you' : run.startedBy === undefined || run.startedBy === null ? '' : ` by ${run.startedBy}`;
  return `Run ${shortId(run.id)}${at === '' ? (run.startedAt === null ? ' · queued' : '') : at}${by}`;
}

function KillDialog({
  runs,
  pick,
  open,
  onClose,
}: {
  /** The audit to stop, or (pick) the live audits to choose from. */
  readonly runs: readonly StoppableRun[];
  readonly pick: boolean;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // The audits a stop was sent for (fixed at the click: the live list empties as they halt).
  const [targets, setTargets] = useState<readonly StoppableRun[]>([]);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const [halts, setHalts] = useState<ReadonlyMap<string, Halt>>(new Map());
  const [audit, setAudit] = useState<{ eventId: string; hash: string } | null>(null);
  const single = runs[0];
  const mine = runs.filter((r) => r.mine === true);
  const chosen = runs.find((r) => r.id === picked);

  async function stop(list: readonly StoppableRun[]): Promise<void> {
    if (busy || list.length === 0) return;
    setBusy(true);
    setError(null);
    // The halt view shows at once (the click settles in well under 2 s); a refusal brings the question back.
    setTargets(list);
    setRequestedAt(new Date().toISOString());
    setPhase('stopping');
    try {
      const answers = await Promise.all(list.map(postKill));
      const sent = answers.filter((a) => a.ok);
      const refused = answers.find((a) => !a.ok);
      if (sent.length === 0) {
        setPhase('confirm');
        setTargets([]);
        setRequestedAt(null);
        setError(refused?.message ?? UNREACHABLE);
        return;
      }
      setTargets(sent.map((a) => a.run));
      if (refused !== undefined) setError(`${refused.run.assetName}: ${refused.message}`);
      setRequestedAt(sent[0]?.killRequestedAt ?? new Date().toISOString());
      setAudit(auditRefSchema.parse(sent[0]?.audit ?? null));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (phase !== 'stopping' || busy) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const read = await Promise.all(
          targets.map(async (t) => {
            const res = await fetch(`/api/runs/${encodeURIComponent(t.id)}?afterSeq=${NO_EVENTS}`, { cache: 'no-store' }).catch(() => null);
            const parsed = res?.ok === true ? haltSchema.safeParse(await res.json()) : null;
            return parsed?.success === true ? ([t.id, parsed.data] as const) : null;
          }),
        );
        const next = new Map(read.flatMap((r) => (r === null ? [] : [r])));
        setHalts((old) => new Map([...old, ...next]));
        if (targets.every((t) => ENDED.includes(next.get(t.id)?.state ?? ''))) {
          setPhase('halted');
          window.dispatchEvent(new Event('bw:refresh'));
          router.refresh();
        }
      })();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase, busy, targets, router]);

  // The halt view replaces the Stop button: move focus to Close so the keyboard is never lost.
  useEffect(() => {
    if (phase === 'halted') document.querySelector<HTMLElement>('dialog[open] [data-autofocus]')?.focus();
  }, [phase]);

  const time = (iso: string | null): string =>
    iso === null ? '' : new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(iso));
  const halted = phase === 'halted';
  // Only decisions the stop closed count: one already answered by hand before it was never "pending at stop".
  const since = requestedAt === null ? Number.POSITIVE_INFINITY : Date.parse(requestedAt) - SKEW_MS;
  const atStop = (halt?.gate2 ?? []).filter((g) => g.status === 'pending' || (g.decidedAt !== null && Date.parse(g.decidedAt) >= since));
  const steps = [
    { label: 'Stop requested', detail: time(requestedAt), done: requestedAt !== null },
    { label: 'Agents halted', detail: halted ? 'No new request is sent' : 'Waiting for the runner…', done: halted },
    {
      label: 'Pending decisions denied',
      detail:
        halt === null
          ? ''
          : atStop.length === 0
            ? 'None were waiting'
            : `${atStop.filter((g) => g.status !== 'pending').length} of ${atStop.length} closed`,
      done: halted && atStop.every((g) => g.status !== 'pending'),
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
                {/* Two audits of one target read the same by name: the run id and start time tell them apart. */}
                <span className="text-xs text-muted-foreground">
                  Run <span className="font-mono">{shortId(run.id)}</span>
                  {run.startedAt === undefined || run.startedAt === null ? '' : ` · started ${time(run.startedAt)}`}
                </span>
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
