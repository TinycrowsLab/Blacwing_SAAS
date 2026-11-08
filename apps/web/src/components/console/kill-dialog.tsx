/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Stop testing (experience spec §6.4, design 3a): one solid-red component everywhere (run header, sidebar pill, mobile
// top bar), rendered only while a run can be stopped. The person picks the blast radius, drawn as nested rings: this
// audit, every audit on its target, or everything in the workspace. One audit needs no typing (the client sends the
// run's short id itself, the API's "you know which run" guard, and Enter stops it); a wider radius stops other
// people's audits too, so the person types the target's or the workspace's name. Then the halt, run by run, from
// each run's real state.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { buttonClass, Icon, INPUT_CLASS, Kbd, OptionCard } from './design';
import { EmergencyLinkCreator } from './emergency-links';
import { Modal } from './modal';
import { shortId } from './run-model';
import { auditRefSchema, sidebarSchema, type SidebarData } from '../../lib/schemas';

const POLL_MS = 500;
const NO_EVENTS = 1_000_000;

export interface StoppableRun {
  readonly id: string;
  /** The target's name: the dialog asks "Stop testing {assetName}?". */
  readonly assetName: string;
  /** The target's id: "This target" stops every live audit on it. */
  readonly assetId?: string | undefined;
  /** When it started, so two audits of one target can be told apart. */
  readonly startedAt?: string | null;
  /** Who started it (the picker names them); null or absent when unknown. */
  readonly startedBy?: string | null;
  /** The viewer started it ("Stop all of mine"). */
  readonly mine?: boolean;
}

/** A live run as the sidebar data has it, in the dialog's terms. */
export const toStoppable = (r: SidebarData['live'][number], actorId: string | null): StoppableRun => ({
  id: r.id,
  assetName: r.assetName ?? 'this audit',
  assetId: r.assetId,
  startedAt: r.startedAt,
  startedBy: r.startedBy?.name ?? null,
  mine: actorId !== null && r.startedBy?.id === actorId,
});

const haltSchema = z.object({
  state: z.string(),
  haltMs: z.number().nullable().default(null),
  gate2: z.array(z.object({ status: z.string(), decidedAt: z.string().nullable().default(null) })).default([]),
});
type Halt = z.infer<typeof haltSchema>;
/** Clock skew allowed between the browser's "now" and the server's decision times. */
const SKEW_MS = 1000;
const ENDED = ['killed', 'completed', 'failed'];

/** The blast radius, innermost first. */
type Scope = 'run' | 'target' | 'workspace';

/** What the person types to stop a whole workspace: its name, or STOP ALL while it has none (the API's rule). */
const workspaceWord = (name: string | null): string => (name === null || name.trim() === '' ? 'STOP ALL' : name.trim());
const fold = (v: string): string => v.trim().replace(/\s+/g, ' ').toLowerCase();
const plural = (n: number, one: string): string => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

/**
 * Opens the Stop dialog. On an audit's own page `run` is that audit (Enter stops it). Elsewhere `choices` are the live
 * audits: the dialog lets the person pick one audit, one target or the whole workspace, nothing preselected. Renders
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
  // Each opening starts fresh: nothing picked, no earlier halt on show.
  const [opens, setOpens] = useState(0);
  const can = run !== null || choices.length > 0;
  const openNow = (): void => {
    setTarget(run ?? 'pick');
    setOpens((n) => n + 1);
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
          key={`${target === 'pick' ? 'pick' : target.id}-${opens}`}
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
  readonly runs: readonly StoppableRun[];
  readonly ok: boolean;
  readonly message: string;
  readonly killRequestedAt: string | null;
  readonly audit: unknown;
}

const UNREACHABLE = "Couldn't reach Blackwing. Nothing was stopped. Try again.";

const answerSchema = z.object({
  message: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
  killRequestedAt: z.string().optional().catch(undefined),
  audit: z.unknown(),
  runs: z.array(z.object({ id: z.string(), assetId: z.string(), assetName: z.string() })).optional().catch(undefined),
});

/** One audit (`/api/runs/:id/kill`) or a wider scope (`/api/kill`): one call either way, the API stops each run. */
async function postKill(url: string, body: unknown, runs: readonly StoppableRun[]): Promise<KillAnswer> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = answerSchema.safeParse(await res.json().catch(() => ({})));
    const a = parsed.success ? parsed.data : { audit: null };
    // A scope answers with the runs it stopped (who started each comes from what the dialog already knows).
    const stopped =
      a.runs?.map((r) => ({ ...runs.find((k) => k.id === r.id), id: r.id, assetId: r.assetId, assetName: r.assetName })) ??
      runs;
    return {
      runs: stopped,
      ok: res.ok,
      message:
        a.code === 'run_not_running'
          ? runs.length === 1
            ? 'This audit has already finished. Nothing is running.'
            : 'Nothing in that scope is running now.'
          : (a.message ?? UNREACHABLE),
      killRequestedAt: a.killRequestedAt ?? null,
      audit: a.audit ?? null,
    };
  } catch {
    return { runs, ok: false, message: UNREACHABLE, killRequestedAt: null, audit: null };
  }
}

const time = (iso: string | null | undefined): string =>
  iso === null || iso === undefined ? '' : new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso));

/** "Run 01A1B9 · started 10:31:05 by Avery": what tells two audits of one target apart. */
function runLine(run: StoppableRun): string {
  const at = time(run.startedAt);
  const by = run.mine === true ? 'you' : (run.startedBy ?? null);
  return `Run ${shortId(run.id)}${at === '' ? ' · not started yet' : ` · started ${at}`}${by === null ? '' : ` by ${by}`}`;
}

/** The live audits and the workspace name, read when the dialog opens so the counts are current. */
function useLive(fallback: readonly StoppableRun[]): {
  readonly runs: readonly StoppableRun[];
  readonly workspace: string | null;
  readonly loaded: boolean;
} {
  const [data, setData] = useState<SidebarData | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      const res = await fetch('/api/sidebar', { cache: 'no-store', signal: ctrl.signal }).catch(() => null);
      const parsed = res?.ok === true ? sidebarSchema.safeParse(await res.json().catch(() => null)) : null;
      if (!ctrl.signal.aborted && parsed?.success === true) setData(parsed.data);
    })();
    return () => {
      ctrl.abort();
    };
  }, []);
  if (data === null) return { runs: fallback, workspace: null, loaded: false };
  return { runs: data.live.map((r) => toStoppable(r, data.actorId)), workspace: data.workspaceName, loaded: true };
}

const RING_LABEL: Readonly<Record<Scope, string>> = {
  workspace: 'Everything in this workspace',
  target: 'This target',
  run: 'This audit',
};

/**
 * The blast radius as nested rings (design 3a): workspace outside, target, then the audit. Every ring inside the chosen
 * one is in scope and filled; the chosen one is edged. A click on a ring picks it (the rows are the keyboard path).
 */
function Rings({
  scope,
  onPick,
  caption,
}: {
  readonly scope: Scope | null;
  readonly onPick: (s: Scope) => void;
  readonly caption: string;
}) {
  const order: readonly Scope[] = ['workspace', 'target', 'run'];
  const reach = scope === null ? -1 : order.indexOf(scope);
  const size = ['size-full', 'size-[68%]', 'size-[36%]'];
  return (
    <div className="order-first flex items-center justify-center gap-4 border-border bg-surface-2 p-6 max-sm:border-b max-sm:px-5 max-sm:py-3 sm:flex-col sm:border-r">
      <div aria-hidden="true" className="relative size-[76px] shrink-0 sm:size-[236px]">
        {order.map((s, i) => {
          const inScope = reach !== -1 && i >= reach;
          return (
            <button
              key={s}
              type="button"
              tabIndex={-1}
              title={RING_LABEL[s]}
              onClick={() => {
                onPick(s);
              }}
              className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${size[i] ?? ''} ${
                s === scope
                  ? 'border-2 border-gold-ink bg-gold-soft'
                  : inScope
                    ? 'border border-gold-line bg-gold-soft'
                    : 'border border-border-strong bg-card hover:bg-gold-soft/60'
              }`}
            />
          );
        })}
      </div>
      <p className="m-0 text-[12.5px] leading-[18px] text-muted-foreground max-sm:flex-1 sm:text-center">{caption}</p>
    </div>
  );
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
  const live = useLive(runs);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // On an audit's page the default is that audit; off it nothing is chosen until the person chooses.
  const [scope, setScope] = useState<Scope | null>(pick ? null : 'run');
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedTarget, setPickedTarget] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  // The audits a stop was sent for (fixed at the click: the live list empties as they halt).
  const [targets, setTargets] = useState<readonly StoppableRun[]>([]);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const [halts, setHalts] = useState<ReadonlyMap<string, Halt>>(new Map());
  const [audit, setAudit] = useState<{ eventId: string; hash: string } | null>(null);
  const single = pick ? undefined : runs[0];
  const mine = runs.filter((r) => r.mine === true);
  // The live list names the target as the person registered it (the run page passes its host).
  const chosen = pick
    ? live.runs.find((r) => r.id === picked)
    : (live.runs.find((r) => r.id === single?.id) ?? single);

  // The targets with live audits, in the order their newest audit started.
  const targetList = [...new Map(live.runs.flatMap((r) => (r.assetId === undefined ? [] : [[r.assetId, r.assetName] as const])))].map(
    ([assetId, assetName]) => ({ assetId, assetName, count: live.runs.filter((r) => r.assetId === assetId).length }),
  );
  const anchorAsset = pick ? pickedTarget : (live.runs.find((r) => r.id === single?.id)?.assetId ?? single?.assetId ?? null);
  const targetName = targetList.find((t) => t.assetId === anchorAsset)?.assetName ?? single?.assetName ?? '';
  const targetCount = live.runs.filter((r) => r.assetId !== undefined && r.assetId === anchorAsset).length;
  const word = scope === 'target' ? targetName : scope === 'workspace' ? workspaceWord(live.workspace) : '';
  const typedOk = word !== '' && fold(typed) === fold(word);
  const reachCount = scope === 'run' ? 1 : scope === 'target' ? targetCount : scope === 'workspace' ? live.runs.length : 0;
  const ready =
    scope === 'run'
      ? chosen !== undefined
      : scope === 'target'
        ? live.loaded && anchorAsset !== null && targetCount > 0 && typedOk
        : scope === 'workspace'
          ? live.loaded && live.runs.length > 0 && typedOk
          : false;
  const why =
    scope === null
      ? 'Choose what to stop first'
      : scope === 'run' && chosen === undefined
        ? 'Pick the audit to stop first'
        : scope === 'target' && anchorAsset === null
          ? 'Pick the target first'
          : !ready && scope !== 'run'
            ? `Type ${word} to confirm`
            : undefined;

  async function send(url: string, body: unknown, list: readonly StoppableRun[]): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    // The halt view shows at once (the click settles in well under 2 s); a refusal brings the question back.
    setTargets(list);
    setRequestedAt(new Date().toISOString());
    setPhase('stopping');
    try {
      const answer = await postKill(url, body, list);
      if (!answer.ok) {
        setPhase('confirm');
        setTargets([]);
        setRequestedAt(null);
        setError(answer.message);
        return;
      }
      setTargets(answer.runs);
      setRequestedAt(answer.killRequestedAt ?? new Date().toISOString());
      setAudit(auditRefSchema.parse(answer.audit));
    } finally {
      setBusy(false);
    }
  }

  /** "Stop all of mine": the viewer's own audits, one per-run call each (the same path as one audit). */
  async function stopMine(list: readonly StoppableRun[]): Promise<void> {
    if (busy || list.length === 0) return;
    setBusy(true);
    setError(null);
    setTargets(list);
    setRequestedAt(new Date().toISOString());
    setPhase('stopping');
    try {
      const answers = await Promise.all(
        list.map((r) => postKill(`/api/runs/${encodeURIComponent(r.id)}/kill`, { scope: 'run', confirm: shortId(r.id) }, [r])),
      );
      const sent = answers.filter((a) => a.ok);
      const refused = answers.find((a) => !a.ok);
      if (sent.length === 0) {
        setPhase('confirm');
        setTargets([]);
        setRequestedAt(null);
        setError(refused?.message ?? UNREACHABLE);
        return;
      }
      setTargets(sent.flatMap((a) => a.runs));
      if (refused !== undefined) setError(`${refused.runs[0]?.assetName ?? ''}: ${refused.message}`);
      setRequestedAt(sent[0]?.killRequestedAt ?? new Date().toISOString());
      setAudit(auditRefSchema.parse(sent[0]?.audit ?? null));
    } finally {
      setBusy(false);
    }
  }

  function stop(e?: { readonly preventDefault: () => void }): void {
    e?.preventDefault();
    if (!ready || busy) return;
    if (scope === 'run' && chosen !== undefined)
      void send(`/api/runs/${encodeURIComponent(chosen.id)}/kill`, { scope: 'run', confirm: shortId(chosen.id) }, [chosen]);
    else if (scope === 'target' && anchorAsset !== null)
      void send('/api/kill', { scope: 'target', assetId: anchorAsset, confirm: typed }, live.runs.filter((r) => r.assetId === anchorAsset));
    else if (scope === 'workspace') void send('/api/kill', { scope: 'workspace', confirm: typed }, live.runs);
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

  const halted = phase === 'halted';
  const many = targets.length > 1;
  const read = targets.flatMap((t) => halts.get(t.id) ?? []);
  // Only decisions the stop closed count: one already answered by hand before it was never "pending at stop".
  const since = requestedAt === null ? Number.POSITIVE_INFINITY : Date.parse(requestedAt) - SKEW_MS;
  const atStop = read
    .flatMap((h) => h.gate2)
    .filter((g) => g.status === 'pending' || (g.decidedAt !== null && Date.parse(g.decidedAt) >= since));
  const measured = read.length === targets.length && read.every((h) => h.haltMs !== null);
  const slowest = Math.max(0, ...read.map((h) => h.haltMs ?? 0));
  // Nothing had started (a queued audit): there was no agent to halt, so no halt time to claim.
  const neverStarted = measured && slowest === 0;
  const ended = read.filter((h) => ENDED.includes(h.state)).length;
  const steps = [
    { label: 'Stop requested', detail: time(requestedAt), done: requestedAt !== null },
    {
      label: 'Agents halted',
      detail: halted ? (neverStarted ? 'No agent had started, nothing was sent' : 'No new request is sent') : many ? `${ended} of ${targets.length} audits halted` : 'Waiting for the runner…',
      done: halted,
    },
    {
      label: 'Pending decisions closed unanswered',
      detail:
        read.length === 0
          ? ''
          : atStop.length === 0
            ? 'None were waiting'
            : `${atStop.filter((g) => g.status !== 'pending').length} of ${atStop.length} closed`,
      done: halted && atStop.every((g) => g.status !== 'pending'),
    },
    {
      label: neverStarted ? 'Stopped before it started' : measured ? `Halt measured in ${slowest.toLocaleString()} ms${many ? ' (the slowest)' : ''}` : 'Halt measured',
      detail: '',
      done: halted && measured,
    },
  ];
  const title =
    phase === 'confirm'
      ? 'Stop testing'
      : halted
        ? many
          ? `Testing stopped on ${targets.length} audits`
          : 'Testing stopped'
        : 'Stopping…';
  const caption =
    scope === null
      ? 'Choose how far the stop reaches'
      : scope === 'run' && chosen === undefined
        ? 'Pick the audit to stop'
        : scope === 'target' && anchorAsset === null
          ? 'Pick the target to stop'
          : !live.loaded
        ? `${RING_LABEL[scope]} stops`
        : `Stops ${reachCount} of ${plural(live.runs.length, 'running audit')}`;
  const choose = (s: Scope): void => {
    setScope(s);
    setTyped('');
    setError(null);
  };
  const pickRow = (on: boolean, n: number, onClick: () => void, name: string, sub: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-autofocus={n === 0 ? '' : undefined}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${on ? 'border-[1.5px] border-gold-ink bg-card' : 'border border-border bg-card hover:bg-surface-2'}`}
    >
      {on ? (
        <Icon name="check" size={16} className="shrink-0 text-gold-ink" />
      ) : (
        <span aria-hidden="true" className="size-4 shrink-0 rounded-full border-[1.5px] border-border-strong" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13.5px] font-semibold">{name}</span>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </span>
    </button>
  );
  /** The row's reach: '…' while the live list loads, nothing until a target is picked. */
  const count = (n: number | null | undefined) =>
    n === undefined ? null : (
      <span className="ml-auto whitespace-nowrap text-[12.5px] text-muted-foreground">
        {n === null ? '…' : plural(n, 'audit')}
      </span>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      label={pick ? 'Stop testing' : `Stop testing ${single?.assetName ?? 'this audit'}`}
      className={phase === 'confirm' ? 'max-w-[860px]' : 'max-w-[560px]'}
    >
      {phase === 'confirm' ? (
        <form onSubmit={stop} className="grid sm:grid-cols-[300px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4 p-5 sm:p-7">
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kill-soft text-kill">
                <Icon name="kill" size={18} />
              </span>
              <h2 className="m-0 min-w-0 break-words text-[20px] font-semibold leading-7">{title}</h2>
            </div>
            {pick && runs.length === 0 && live.loaded && live.runs.length === 0 ? (
              <p className="m-0 text-[13.5px] text-muted-foreground">No audit is running now. Nothing to stop.</p>
            ) : (
              <div role="radiogroup" aria-label="What to stop" className="flex flex-col gap-2.5">
                <OptionCard
                  name="kill-scope"
                  value="run"
                  checked={scope === 'run'}
                  onChange={() => {
                    choose('run');
                  }}
                  title={pick ? 'One audit' : 'This audit'}
                  badge={count(1)}
                  description={
                    chosen === undefined ? 'Pick it from the running audits' : (
                      <>
                        <span className="block truncate">{chosen.assetName}</span>
                        <span className="block">{runLine(chosen)}</span>
                      </>
                    )
                  }
                >
                  {pick ? (
                    // Nothing is preselected: the person names the audit, so a stop never lands on someone else's by default.
                    <span role="radiogroup" aria-label="Running audits" className="flex max-h-[30dvh] flex-col gap-2 overflow-y-auto">
                      {live.runs.map((r, n) =>
                        pickRow(r.id === picked, n, () => {
                          setPicked(r.id);
                        }, r.assetName, runLine(r)),
                      )}
                    </span>
                  ) : undefined}
                </OptionCard>
                <OptionCard
                  name="kill-scope"
                  value="target"
                  checked={scope === 'target'}
                  onChange={() => {
                    choose('target');
                  }}
                  title={pick ? 'One target' : 'This target'}
                  badge={count(anchorAsset === null ? undefined : live.loaded ? targetCount : null)}
                  description={
                    anchorAsset === null ? 'Every audit on the target you pick' : `${targetName}, every audit on it`
                  }
                >
                  {pick ? (
                    <span role="radiogroup" aria-label="Targets with running audits" className="flex max-h-[30dvh] flex-col gap-2 overflow-y-auto">
                      {targetList.map((t, n) =>
                        pickRow(t.assetId === pickedTarget, n, () => {
                          setPickedTarget(t.assetId);
                          setTyped('');
                        }, t.assetName, `${plural(t.count, 'audit')} running`),
                      )}
                    </span>
                  ) : undefined}
                </OptionCard>
                <OptionCard
                  name="kill-scope"
                  value="workspace"
                  checked={scope === 'workspace'}
                  onChange={() => {
                    choose('workspace');
                  }}
                  title="Everything in this workspace"
                  badge={count(live.loaded ? live.runs.length : null)}
                  description={`${live.workspace ?? 'This workspace'}, every audit on every target`}
                />
              </div>
            )}
            <p className="m-0 text-[13px] leading-5 text-muted-foreground">
              Every agent in scope halts now. Requests already on the wire may finish; nothing new is sent. Pending
              decisions close unanswered, so nothing they ask for is sent. Findings so far are kept.
            </p>
            {(scope === 'target' || scope === 'workspace') && word !== '' ? (
              <label className="flex flex-col gap-2 text-[13.5px] font-medium">
                <span>
                  Type{' '}
                  <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px]">{word}</code>{' '}
                  to confirm
                </span>
                <input
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={typed !== '' && !typedOk && !fold(word).startsWith(fold(typed))}
                  className={INPUT_CLASS}
                />
              </label>
            ) : null}
            {error === null ? null : (
              <p role="alert" className="m-0 text-[13px] text-bad">
                {error}
              </p>
            )}
            <div className="flex flex-col-reverse gap-2.5 border-t border-border pt-4 max-sm:sticky max-sm:bottom-0 max-sm:bg-card max-sm:pb-2 sm:flex-row sm:items-center sm:justify-end">
              <span className="text-xs text-muted-foreground sm:mr-auto">Recorded in the ledger</span>
              <button type="button" onClick={onClose} className={buttonClass('secondary', 'h-11 px-5')}>
                Keep running
              </button>
              {pick && mine.length > 0 && runs.length > 1 && scope === null ? (
                <button type="button" disabled={busy} onClick={() => void stopMine(mine)} className={buttonClass('secondary', 'h-11 px-5 text-kill')}>
                  Stop all of mine ({mine.length})
                </button>
              ) : null}
              {/* On an audit's own page Stop has the focus (Enter stops it); off it nothing stops by default. */}
              <button
                type="submit"
                data-autofocus={pick ? undefined : ''}
                disabled={busy || !ready}
                title={why}
                className={buttonClass('kill', 'h-11 px-5 text-[14px]')}
              >
                {busy ? (
                  <span aria-hidden="true" className="size-3.5 rounded-full border-2 border-current border-t-transparent motion-safe:animate-[bwspin_0.8s_linear_infinite]" />
                ) : (
                  <Icon name="kill" size={16} />
                )}
                {busy ? 'Stopping…' : reachCount > 1 && ready ? `Stop ${plural(reachCount, 'audit')}` : 'Stop testing'}
                {ready ? <Kbd>Enter</Kbd> : null}
              </button>
            </div>
            {/* Design 3b: a link someone without a login can use to stop everything (also in Settings). */}
            <details className="group border-t border-border pt-4">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
                <Icon name="key" size={14} className="shrink-0" />
                <span className="min-w-0 flex-1">Send an emergency stop link to someone without a login</span>
                <Icon name="chevron" size={14} className="shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <div className="pt-3">
                <EmergencyLinkCreator />
              </div>
            </details>
          </div>
          {/* After the controls in the DOM (focus lands on them first), drawn first. */}
          <Rings scope={scope} onPick={choose} caption={caption} />
        </form>
      ) : (
        <div className="flex flex-col gap-5 p-6 sm:p-7">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-kill-soft text-kill">
              <Icon name="kill" size={20} />
            </span>
            <h2 className="m-0 min-w-0 break-words text-[20px] font-semibold leading-7">{title}</h2>
          </div>
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
          {/* Every stopped audit with its own measured halt time. */}
          <ul aria-label="Stopped audits" className="m-0 flex max-h-[32dvh] list-none flex-col overflow-y-auto rounded-xl border border-border p-0">
            {targets.map((t) => {
              const h = halts.get(t.id);
              const done = h !== undefined && ENDED.includes(h.state);
              return (
                <li key={t.id} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-medium">{t.assetName}</span>
                    <span className="font-mono text-[11.5px] text-muted-foreground">Run {shortId(t.id)}</span>
                  </span>
                  <span className={`whitespace-nowrap text-[12.5px] tabular-nums ${done ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {!done
                      ? 'Stopping…'
                      : h.state !== 'killed'
                        ? 'Had already ended'
                        : h.haltMs === null
                          ? 'Halted'
                          : h.haltMs === 0
                            ? 'Stopped before it started'
                          : `Halted in ${h.haltMs.toLocaleString()} ms`}
                  </span>
                </li>
              );
            })}
          </ul>
          {error === null ? null : (
            <p role="alert" className="m-0 text-[13px] text-bad">
              {error}
            </p>
          )}
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
        </div>
      )}
    </Modal>
  );
}
