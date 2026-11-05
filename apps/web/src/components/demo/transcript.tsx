/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Transcript (design 1b): the run as a conversation without a prompt box. Agent text is labelled "not verified",
// HTTP requests are inline chips, and a Gate 2 request appears where the agent asked, with the decision buttons.
import { Card, Icon } from './design';
import { Gate2Buttons, useGate2Clock } from './gate2-actions';
import { clock, describe, mmss, pathOf } from './run-model';

import type { DemoGate2, DemoRunEvent } from '../../app/demo/_lib/schemas';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function statusTone(status: number): string {
  if (status >= 400 || status === 0) return 'bg-warn-soft text-warn';
  return 'bg-ok-soft text-ok';
}

function HttpRow({ e }: { readonly e: DemoRunEvent }) {
  const status = typeof e.data.status === 'number' ? e.data.status : 0;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 font-mono text-[12.5px]">
      <span className="font-medium text-primary">{str(e.data.method)}</span>
      <span className="min-w-0 flex-1 truncate">{pathOf(str(e.data.url))}</span>
      <span className={`rounded px-1.5 py-0.5 text-xs ${statusTone(status)}`}>{status}</span>
      <span className="text-[11.5px] text-muted-foreground">
        {String(typeof e.data.ms === 'number' ? e.data.ms : 0)} ms
      </span>
    </div>
  );
}

function BlockedRow({ e }: { readonly e: DemoRunEvent }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-warn bg-warn-soft px-3 py-2 font-mono text-[12.5px] text-warn">
      <Icon name="warn" size={14} />
      <span className="min-w-0 flex-1 truncate">
        {str(e.data.method)} {str(e.data.url)}
      </span>
      <span className="text-xs">blocked, {str(e.data.rule)}</span>
    </div>
  );
}

function Gate2Card({ gate2 }: { readonly gate2: DemoGate2 }) {
  const pending = gate2.status === 'pending';
  const { left, total } = useGate2Clock(gate2.deadlineAt, gate2.createdAt, pending);
  const open = pending && left > 0;
  const expired = pending && left === 0;
  return (
    <div className="overflow-hidden rounded-xl border border-warn bg-card">
      <div className="flex items-center justify-between bg-warn-soft px-4 py-3">
        <span className="text-[13.5px] font-semibold text-warn">
          Gate 2: {open ? 'decision needed' : expired ? 'expired, denied' : gate2.status}
        </span>
        {pending ? <span className="text-2xl font-semibold tabular-nums">{mmss(left)}</span> : null}
      </div>
      <div className="flex flex-col gap-3 p-4 text-[13.5px]">
        <p>
          Wants to send{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px]">
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
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.killed',
]);

export function Transcript({
  events,
  gate2,
}: {
  readonly events: readonly DemoRunEvent[];
  readonly gate2: readonly DemoGate2[];
}) {
  return (
    <div className="flex flex-col gap-3" aria-label="Transcript">
      {events.map((e) => {
        if (e.kind === 'agent.message') {
          return (
            <div key={e.seq} className="flex flex-col gap-1.5 pt-3">
              <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                <span className="flex size-6 items-center justify-center rounded-md border border-border bg-card">
                  <Icon name="agent" size={13} />
                </span>
                <span className="font-mono text-[13px] font-medium text-foreground">
                  {str(e.data.agent) || e.stage}
                </span>
                <span>{clock(e.at)} UTC</span>
                <span className="rounded border border-dashed border-border-strong px-1.5 py-px">
                  not verified
                </span>
              </div>
              <p className="m-0 whitespace-pre-wrap pl-[34px] text-[14px] leading-6">
                {str(e.data.text)}
              </p>
            </div>
          );
        }
        if (e.kind === 'http.sent')
          return (
            <div key={e.seq} className="pl-[34px]">
              <HttpRow e={e} />
            </div>
          );
        if (e.kind === 'policy.blocked')
          return (
            <div key={e.seq} className="pl-[34px]">
              <BlockedRow e={e} />
            </div>
          );
        if (e.kind === 'gate2.requested') {
          const g = gate2.find((x) => x.id === str(e.data.gate2Id));
          return g === undefined ? null : (
            <div key={e.seq} className="pl-[34px]">
              <Gate2Card gate2={g} />
            </div>
          );
        }
        if (NOTE_KINDS.has(e.kind)) {
          const row = describe(e);
          return row === null ? null : (
            <p key={e.seq} className="m-0 pl-[34px] text-[12.5px] text-muted-foreground">
              {clock(e.at)} {row.text}
            </p>
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
