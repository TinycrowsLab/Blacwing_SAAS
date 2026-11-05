/* Presentational values (poll interval, gauge scales) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// The live run screen (design 1a flight deck and 1b transcript). The first render comes from the server; this
// component polls the demo route every 1.5 s until the run is terminal and merges the new events.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Card, Chip, Icon, PageHeader, StatusChip, buttonClass } from './design';
import {
  ActivityTable,
  AgentTeam,
  CandidateList,
  Gauge,
  ProgressCard,
  ReportCard,
  SummaryCard,
  TestCasesCard,
} from './flight-deck';
import { useGate2Clock } from './gate2-actions';
import { KillButton } from './kill-dialog';
import { Modal } from './modal';
import {
  TERMINAL_STATES,
  agentLanes,
  candidates,
  describe,
  mmss,
  pathOf,
  shortId,
  mergeEvents,
  testCases,
} from './run-model';
import { Transcript } from './transcript';
import { useNow } from './use-now';
import {
  type DemoRun,
  type DemoRunEvent,
  runSchema,
  type DemoGate2,
} from '../../app/demo/_lib/schemas';

const POLL_MS = 1500;
type Tab = 'deck' | 'transcript';

function Gate2Banner({ gate2 }: { readonly gate2: DemoGate2 }) {
  const { left } = useGate2Clock(gate2.deadlineAt, gate2.createdAt, true, gate2.secondsLeft);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3.5 rounded-xl border border-warn bg-warn-soft px-4 py-3"
    >
      <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
        <span className="absolute inset-0 rounded-full bg-warn motion-safe:animate-ping" />
        <span className="absolute inset-0 rounded-full bg-warn" />
      </span>
      <span className="min-w-0 flex-1 text-[13.5px]">
        <strong className="font-semibold">
          {gate2.agent} wants to send {gate2.method} {pathOf(gate2.url)}.
        </strong>{' '}
        If no one decides, it is denied in <strong className="tabular-nums">{mmss(left)}</strong>.
      </span>
      <Link href={`/demo/approvals/gate2/${gate2.id}`} className={buttonClass('deny', 'h-9')}>
        Review
      </Link>
    </div>
  );
}

function AuthStrip({ run, nowMs }: { readonly run: DemoRun; readonly nowMs: number }) {
  const auth = run.pins.authorisation;
  const origins = run.pins.asset?.allowedOrigins ?? [];
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = start + run.budget.seconds * 1000;
  const hm = (t: number): string => new Date(t).toISOString().slice(11, 16);
  const items = [
    { k: 'Scope', v: origins.length === 0 ? 'not recorded' : origins.join(', ') },
    { k: 'Window', v: `${hm(start)} to ${hm(end)} UTC` },
    {
      k: 'Max intrusiveness',
      v: (run.pins.request?.intrusiveness ?? 'active_safe').replace(/_/g, '-'),
    },
    {
      k: 'Expires',
      v: nowMs === 0 ? '' : end > nowMs ? `in ${Math.ceil((end - nowMs) / 60000)} min` : 'expired',
    },
  ];
  return (
    <div className="flex flex-wrap rounded-xl border border-border bg-card">
      <div className="flex min-w-[240px] items-center gap-3 border-b border-border px-4 py-3 md:border-b-0 md:border-r">
        <Icon name="shield" size={20} className="text-ok" />
        <span className="flex flex-col">
          <span className="text-[13px] font-semibold">
            Authorised under {auth?.saId ?? 'unknown'}
          </span>
          <span className="text-xs text-muted-foreground">
            Signed by {auth?.signedBy ?? 'unknown'}, key {auth?.keyId ?? 'unknown'}
          </span>
        </span>
      </div>
      {items.map((a) => (
        <div
          key={a.k}
          className="flex min-w-0 flex-1 basis-[160px] flex-col justify-center border-b border-border px-4 py-2.5 md:border-b-0 md:border-r last:border-r-0"
        >
          <span className="text-[11.5px] text-muted-foreground">{a.k}</span>
          <span className="break-words text-[12.5px] font-medium">{a.v}</span>
        </div>
      ))}
    </div>
  );
}

export function RunView({ initial }: { readonly initial: DemoRun }) {
  const [run, setRun] = useState<DemoRun>(initial);
  const [events, setEvents] = useState<DemoRunEvent[]>(initial.events);
  const [tab, setTab] = useState<Tab>('deck');
  const [stale, setStale] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [manifest, setManifest] = useState(false);
  const lastSeq = useRef(initial.lastSeq);
  const running = !TERMINAL_STATES.has(run.state);
  const nowMs = useNow(running);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(
        `/demo/api/runs/${encodeURIComponent(initial.id)}?afterSeq=${lastSeq.current}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error(String(res.status));
      const next = runSchema.parse(await res.json());
      lastSeq.current = Math.max(lastSeq.current, next.lastSeq);
      setStale(false);
      setRun(next);
      if (next.events.length > 0) setEvents((prev) => mergeEvents(prev, next.events));
    } catch {
      setStale(true);
    }
  }, [initial.id]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void poll();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [running, poll]);

  async function control(action: 'pause' | 'resume') {
    setControlError(null);
    const res = await fetch(`/demo/api/runs/${encodeURIComponent(run.id)}/${action}`, {
      method: 'POST',
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { message?: unknown };
      setControlError(
        typeof problem.message === 'string' ? problem.message : `${action} was refused.`,
      );
      return;
    }
    await poll();
  }

  const assetName = run.pins.asset?.name ?? 'Assessment';
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end =
    run.finishedAt === null ? (nowMs === 0 ? start : nowMs) : new Date(run.finishedAt).getTime();
  const elapsed = Math.max(0, (end - start) / 1000);
  const lanes = useMemo(() => agentLanes(events), [events]);
  const rows = useMemo(() => events.flatMap((e) => describe(e) ?? []), [events]);
  const cands = useMemo(() => candidates(events), [events]);
  const plan = useMemo(() => testCases(events), [events]);
  const pending = run.gate2.filter(
    (g) => g.status === 'pending' && new Date(g.deadlineAt).getTime() > nowMs,
  );
  const lastPause = events.findLast((e) => e.kind === 'run.paused');

  const pausedFrom = (agent: string): number | null => {
    const g = pending.find((x) => x.agent === agent);
    if (g !== undefined)
      return g.createdAt === undefined
        ? nowMs === 0
          ? start
          : nowMs
        : new Date(g.createdAt).getTime();
    return run.paused && lastPause !== undefined ? new Date(lastPause.at).getTime() : null;
  };

  const state = run.paused && running ? 'paused' : run.state;
  const requestsPct = (run.requestsUsed / Math.max(1, run.budget.requests)) * 100;
  const costPct = (run.costUsd / Math.max(0.01, run.budget.costUsd)) * 100;
  const durationPct = (elapsed / Math.max(1, run.budget.seconds)) * 100;
  const side = (
    <div className="flex flex-col gap-4">
      <TestCasesCard plan={plan} />
      <ProgressCard
        stats={{
          httpSent: run.stats.httpSent,
          blocked: run.stats.blocked,
          candidates: cands.length,
          confirmed: cands.filter((c) => c.status === 'confirmed' || c.status === 'released')
            .length,
        }}
      />
      <CandidateList items={cands} running={running} />
      {running ? null : <ReportCard runId={run.id} />}
    </div>
  );

  return (
    <section aria-label="Live run" className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Assessments', href: '/demo' }, { label: `run_${shortId(run.id)}` }]}
        title={assetName}
        chips={
          <>
            <Chip tone="muted" bordered>
              {(run.pins.request?.testAccounts?.length ?? 0) > 0 ? 'Grey box' : 'Black box'}
            </Chip>
            <StatusChip value={state} />
          </>
        }
        actions={
          <>
            <button
              type="button"
              disabled={!running}
              onClick={() => void control(run.paused ? 'resume' : 'pause')}
              className={buttonClass('secondary')}
            >
              <Icon name="pause" size={15} />
              {run.paused ? 'Resume' : 'Pause run'}
            </button>
            <button
              type="button"
              onClick={() => {
                setManifest(true);
              }}
              className={buttonClass('secondary')}
            >
              Run manifest
            </button>
            <KillButton run={running ? { id: run.id, assetName } : null} className="h-11 px-5" />
          </>
        }
      />
      <Modal
        open={manifest}
        onClose={() => {
          setManifest(false);
        }}
        label="Run manifest"
        className="max-w-[720px]"
      >
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-lg font-semibold">Run manifest</h2>
          <p className="text-[12.5px] text-muted-foreground">
            What was pinned when this run started.
          </p>
          <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-code p-3 font-mono text-[12px]">
            {JSON.stringify(run.pins, null, 2)}
          </pre>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                setManifest(false);
              }}
              className={buttonClass('secondary')}
            >
              Close
            </button>
          </div>
        </div>
      </Modal>

      {controlError === null ? null : (
        <p role="alert" className="text-[13px] text-bad">
          {controlError}
        </p>
      )}
      {stale ? (
        <p role="status" className="flex items-center gap-1.5 text-[13px] text-warn">
          <Icon name="warn" size={14} /> Connection lost, retrying
        </p>
      ) : null}
      {pending.map((g) => (
        <Gate2Banner key={g.id} gate2={g} />
      ))}
      {run.state === 'killed' ? (
        <p role="status" className="rounded-xl border border-kill bg-card px-4 py-3 text-[13.5px]">
          <strong className="font-semibold text-kill">Run killed.</strong> Measured halt time{' '}
          {run.haltMs === null ? 'not recorded' : `${run.haltMs} ms`}.
        </p>
      ) : null}
      <AuthStrip run={run} nowMs={nowMs} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card as="div" className="flex flex-col gap-0.5 p-4">
          <span className="text-xs text-muted-foreground">Elapsed</span>
          <span className="text-[30px] font-semibold leading-9 tabular-nums">{mmss(elapsed)}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {new Date(end).toISOString().slice(11, 19)} UTC
          </span>
        </Card>
        <Gauge
          label="Model cost"
          cap={`cap $${run.budget.costUsd.toFixed(2)}`}
          value={`$${run.costUsd.toFixed(2)}`}
          pct={costPct}
        />
        <Gauge
          label="Requests"
          cap={`budget ${run.budget.requests}`}
          value={String(run.requestsUsed)}
          pct={requestsPct}
        />
        <Gauge
          label="Duration"
          cap={`max ${Math.round(run.budget.seconds / 60)} min`}
          value={`${Math.round(durationPct)}%`}
          pct={durationPct}
        />
      </div>

      <div role="tablist" aria-label="Run view" className="flex gap-2">
        {(['deck', 'transcript'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
            }}
            className={`h-9 rounded-full px-4 text-[13px] font-medium ${tab === t ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-surface-2'}`}
          >
            {t === 'deck' ? 'Flight deck' : 'Transcript'}
          </button>
        ))}
      </div>

      {tab === 'deck' ? (
        <>
          <AgentTeam lanes={lanes} nowMs={end} running={running} pausedFrom={pausedFrom} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <ActivityTable rows={rows} />
            {side}
          </div>
          {run.summary === null ? null : <SummaryCard text={run.summary} />}
        </>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Transcript events={events} gate2={run.gate2} />
            <div className="sticky bottom-3 flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-card px-4 py-3 shadow-lg">
              <button
                type="button"
                disabled={!running}
                onClick={() => void control(run.paused ? 'resume' : 'pause')}
                className={buttonClass('ghost', 'bg-surface-2')}
              >
                <Icon name="pause" size={14} />
                {run.paused ? 'Resume' : 'Pause'}
              </button>
              {[
                { l: 'Model cost', v: `$${run.costUsd.toFixed(2)}`, p: costPct },
                { l: 'Requests', v: String(run.requestsUsed), p: requestsPct },
                { l: 'Duration', v: `${Math.round(durationPct)}%`, p: durationPct },
              ].map((m) => (
                <div key={m.l} className="flex min-w-[110px] flex-1 flex-col gap-1">
                  <span className="flex justify-between text-xs text-muted-foreground">
                    {m.l}
                    <span className="font-medium text-primary">{m.v}</span>
                  </span>
                  <span className="h-1 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full bg-primary"
                      style={{ width: `${Math.min(100, m.p)}%` }}
                    />
                  </span>
                </div>
              ))}
              <span className="text-xs text-muted-foreground">
                Controls only. No free-text steering.
              </span>
            </div>
          </div>
          {side}
        </div>
      )}
    </section>
  );
}
