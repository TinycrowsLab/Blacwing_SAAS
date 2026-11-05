/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Transcript (design 1b): the run as a conversation without a prompt box. Agent text is labelled "not verified",
// HTTP requests are inline chips, and a Gate 2 request appears where the agent asked, with the decision buttons.
import { useState } from 'react';

import { Card, Icon, SeverityChip } from './design';
import { Gate2Buttons, useGate2Clock } from './gate2-actions';
import { Markdown } from './markdown';
import { clock, describe, mmss, pathOf } from './run-model';

import type { DemoGate2, DemoRunEvent } from '../../app/demo/_lib/schemas';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Calls shown under a message before the "Show N more" toggle. */
const CALLS_SHOWN = 3;
const FINAL_MINUTE_S = 60;
const WARN_BELOW_S = 300;

const CALL_ROW =
  'flex items-center gap-3 rounded-[10px] border bg-card px-3 py-2 font-mono text-[12.5px]';

function statusTone(status: number): string {
  if (status >= 500) return 'bg-bad-soft text-bad';
  if (status >= 300 || status === 0) return 'bg-warn-soft text-warn';
  return 'bg-ok-soft text-ok';
}

function HttpRow({ e }: { readonly e: DemoRunEvent }) {
  const status = typeof e.data.status === 'number' ? e.data.status : 0;
  return (
    <div className={`${CALL_ROW} border-border`}>
      <span className="font-medium text-primary">{str(e.data.method)}</span>
      <span className="min-w-0 flex-1 truncate">{pathOf(str(e.data.url))}</span>
      <span className={`rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium ${statusTone(status)}`}>
        {status}
      </span>
      <span className="text-[11.5px] text-muted-foreground">
        {String(typeof e.data.ms === 'number' ? e.data.ms : 0)} ms
      </span>
    </div>
  );
}

function BlockedRow({ e }: { readonly e: DemoRunEvent }) {
  return (
    <div className={`${CALL_ROW} border-warn bg-warn-soft text-warn`}>
      <Icon name="warn" size={14} />
      <span className="min-w-0 flex-1 truncate">
        {str(e.data.method)} {str(e.data.url)}
      </span>
      <span className="text-xs">blocked, {str(e.data.rule)}</span>
    </div>
  );
}

/** Consecutive requests stay grouped under the message that made them. */
function CallGroup({ calls }: { readonly calls: readonly DemoRunEvent[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? calls : calls.slice(0, CALLS_SHOWN);
  return (
    <div className="flex flex-col gap-1.5 pl-9">
      {shown.map((e) =>
        e.kind === 'http.sent' ? <HttpRow key={e.seq} e={e} /> : <BlockedRow key={e.seq} e={e} />,
      )}
      {calls.length > CALLS_SHOWN ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
          className="self-start text-[12.5px] font-medium text-primary hover:underline"
        >
          {all ? 'Show fewer' : `Show ${calls.length - CALLS_SHOWN} more`}
        </button>
      ) : null}
    </div>
  );
}

function Gate2Card({ gate2 }: { readonly gate2: DemoGate2 }) {
  const pending = gate2.status === 'pending';
  const { left, total } = useGate2Clock(
    gate2.deadlineAt,
    gate2.createdAt,
    pending,
    gate2.secondsLeft,
  );
  const open = pending && left > 0;
  const expired = pending && left === 0;
  const clockTone =
    left <= FINAL_MINUTE_S ? 'text-bad' : left < WARN_BELOW_S ? 'text-warn' : 'text-text';
  const strip = pending
    ? 'bg-warn-soft text-warn'
    : gate2.status === 'approved'
      ? 'bg-ok-soft text-ok'
      : 'bg-surface-2 text-muted-foreground';
  return (
    <div className="ml-9 overflow-hidden rounded-2xl border-[1.5px] border-warn bg-card">
      <div className={`flex items-center justify-between px-4 py-3 ${strip}`}>
        <span className="text-[13.5px] font-semibold">
          Gate 2: {open ? 'decision needed' : expired ? 'expired, denied' : gate2.status}
        </span>
        {pending ? (
          <span className={`text-[20px] font-semibold tabular-nums ${clockTone}`}>
            {mmss(left)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 p-4 text-[13.5px]">
        <p className="leading-6">
          Wants to send{' '}
          <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px]">
            {gate2.method} {pathOf(gate2.url)}
          </code>
          . {gate2.whyOutside === '' ? 'This is a state-changing request.' : gate2.whyOutside} The
          branch stays paused until someone decides.
        </p>
        {pending ? (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-text" style={{ width: `${(left / total) * 100}%` }} />
            </div>
            <Gate2Buttons gate2Id={gate2.id} open={open} />
          </>
        ) : null}
      </div>
    </div>
  );
}

const NOTE_KINDS = new Set([
  'candidate.submitted',
  'finding.confirmed',
  'finding.not_confirmed',
  'finding.suspected',
  'finding.released',
  'finding.dismissed',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.killed',
]);

const isCall = (e: DemoRunEvent): boolean => e.kind === 'http.sent' || e.kind === 'policy.blocked';

export function Transcript({
  events,
  gate2,
}: {
  readonly events: readonly DemoRunEvent[];
  readonly gate2: readonly DemoGate2[];
}) {
  const items: (DemoRunEvent | DemoRunEvent[])[] = [];
  for (const e of events) {
    if (
      !isCall(e) &&
      e.kind !== 'agent.message' &&
      e.kind !== 'gate2.requested' &&
      !NOTE_KINDS.has(e.kind)
    )
      continue;
    const last = items.at(-1);
    if (!isCall(e)) items.push(e);
    else if (Array.isArray(last)) last.push(e);
    else items.push([e]);
  }
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[22px]" aria-label="Transcript">
      {items.map((item) => {
        if (Array.isArray(item)) return <CallGroup key={item[0]?.seq} calls={item} />;
        const e = item;
        if (e.kind === 'agent.message') {
          return (
            <div key={e.seq} className="flex flex-col gap-2">
              <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                <span className="flex size-[26px] items-center justify-center rounded-lg bg-surface-2">
                  <Icon name="agent" size={15} />
                </span>
                <span className="font-mono text-[13px] font-medium text-foreground">
                  {str(e.data.agent) || e.stage}
                </span>
                <span>{clock(e.at)} UTC</span>
                <span className="rounded border border-dashed border-border-strong px-1.5 py-px">
                  not verified
                </span>
              </div>
              <Markdown text={str(e.data.text)} className="pl-9 text-[14.5px] leading-[25px]" />
            </div>
          );
        }
        if (e.kind === 'gate2.requested') {
          const g = gate2.find((x) => x.id === str(e.data.gate2Id));
          return g === undefined ? null : <Gate2Card key={e.seq} gate2={g} />;
        }
        if (NOTE_KINDS.has(e.kind)) {
          const row = describe(e);
          return row === null ? null : (
            <div
              key={e.seq}
              className="ml-9 flex items-center gap-3 rounded-[10px] border border-border bg-card px-3 py-2 text-[12.5px]"
            >
              {e.kind === 'candidate.submitted' ? (
                <SeverityChip severity={str(e.data.severity)} />
              ) : null}
              <span className="min-w-0 flex-1">{row.text}</span>
              <span className="font-mono text-[11.5px] text-muted-foreground">{clock(e.at)}</span>
            </div>
          );
        }
        return null;
      })}
      {events.length === 0 ? (
        <Card as="div" className="p-4 text-[13px] text-muted-foreground">
          Waiting for the first message.
        </Card>
      ) : null}
    </div>
  );
}
