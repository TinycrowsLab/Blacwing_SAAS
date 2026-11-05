/* Presentational values (ring geometry) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// Gate 2 decision screen. The ring drains to zero; at zero the worker denies the request on its own.
import Link from 'next/link';

import { AgentText, Chip, Icon, LinkButton } from './design';
import { Gate2Buttons, useGate2Clock } from './gate2-actions';
import { auditLine, mmss, pathOf, shortId } from './run-model';

import type { gate2DetailSchema } from '../../app/demo/_lib/schemas';
import type { z } from 'zod';

const SIZE = 300;
const RADIUS = 128;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const WARN_BELOW = 300;
const BAD_BELOW = 60;

type Gate2 = z.infer<typeof gate2DetailSchema>;

/** Ring colour: text normally, warn under five minutes, bad in the last minute. */
function ringColour(left: number): string {
  if (left < BAD_BELOW) return 'var(--bad)';
  if (left < WARN_BELOW) return 'var(--warn)';
  return 'var(--text)';
}

function WhyOutside({ gate2 }: { readonly gate2: Gate2 }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 text-[13px]">
      <h3 className="text-[13px] font-semibold">Why this is outside the authorisation</h3>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <span className="rounded-[5px] bg-bad-soft px-2 py-0.5 text-[11.5px] font-medium text-bad">
          ABOVE MAX
        </span>
        <span className="font-mono text-[12.5px]">{gate2.method}</span>
        <span className="text-muted-foreground">
          Runs are authorised for active-safe requests. State-changing needs a human.
        </span>
      </p>
      {gate2.whyOutside === '' ? null : (
        <p className="m-0 text-muted-foreground">{gate2.whyOutside}</p>
      )}
    </div>
  );
}

function agentReason(gate2: Gate2): string {
  return gate2.reason === '' ? '(none given)' : gate2.reason;
}

function doneCopy(closed: string, gate2: Gate2): { title: string; body: string } {
  if (closed === 'approved')
    return {
      title: 'Approved once',
      body: `The request was sent. Approval covers ${gate2.method} ${pathOf(gate2.url).split('?')[0]} for the rest of the run.`,
    };
  if (closed === 'expired')
    return {
      title: 'Expired, denied',
      body: 'No one decided in time, so the request was denied. The branch moves on to its next test case and the agent is told the action is out of scope.',
    };
  return {
    title: 'Denied',
    body: 'The request was not sent. The branch moves on to its next test case and the agent is told the action is out of scope.',
  };
}

export function Gate2View({ gate2 }: { readonly gate2: Gate2 }) {
  const deadline = new Date(gate2.deadlineAt);
  const pending = gate2.status === 'pending';
  const { left, total } = useGate2Clock(
    gate2.deadlineAt,
    gate2.createdAt,
    pending,
    gate2.secondsLeft,
  );
  const open = pending && left > 0;
  const closed = pending && left === 0 ? 'expired' : gate2.status;
  const urgent = open && left < BAD_BELOW;
  const colour = open ? ringColour(left) : 'var(--text)';
  const label = !open
    ? 'Closed'
    : left < BAD_BELOW
      ? 'Final minute'
      : left < WARN_BELOW
        ? 'Under 5 minutes'
        : 'Auto-deny in';
  let origin = gate2.url;
  try {
    origin = new URL(gate2.url).host;
  } catch {
    /* keep the raw url */
  }
  const request = `${gate2.method} ${pathOf(gate2.url).split('?')[0]}`;
  const runLink = (
    <Link href={`/demo/runs/${gate2.runId}`} className="font-mono text-primary hover:underline">
      run_{shortId(gate2.runId)}
    </Link>
  );
  const done = doneCopy(closed, gate2);
  return (
    <div>
      <h1 className="sr-only">
        Gate 2: {request} ({open ? 'decision needed' : closed})
      </h1>

      <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:grid md:grid-cols-[400px_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-5 border-r border-border bg-card p-8">
          <nav
            aria-label="Breadcrumb"
            className="self-start text-[12.5px] font-medium text-muted-foreground"
          >
            <Link href="/demo" className="hover:underline">
              Approvals
            </Link>
            {' / Gate 2 / '}
            <span aria-current="page">g2_{shortId(gate2.id)}</span>
          </nav>
          <div className="relative aspect-square w-full max-w-[300px]">
            <svg
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="size-full -rotate-90"
              aria-hidden="true"
            >
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth="12"
                style={{ stroke: 'var(--surface2)' }}
              />
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - left / total)}
                style={{ stroke: colour, transition: 'stroke-dashoffset 1s linear' }}
              />
            </svg>
            <div
              className="absolute inset-0 flex flex-col items-center justify-center"
              role="timer"
              aria-live="off"
            >
              <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
              <span
                className={`text-[64px] font-semibold leading-[72px] tabular-nums ${urgent ? 'motion-safe:animate-[bwpulse_1s_ease-in-out_infinite]' : ''}`}
                style={{ color: colour }}
              >
                {mmss(left)}
              </span>
              <span className="text-[12.5px] text-muted-foreground">of {mmss(total)} allowed</span>
            </div>
          </div>
          <p className="m-0 text-center text-sm font-medium leading-[22px]">
            If no one decides, this action
            <br />
            is <span className="text-bad">denied automatically</span>.
          </p>
          <p className="m-0 text-xs text-muted-foreground">
            Deadline {deadline.toISOString().slice(11, 19)} UTC
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-5 bg-bg p-8">
          {pending ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-muted-foreground">
                  {gate2.agent} wants to
                </span>
                <p className="m-0 break-words font-mono text-[26px] font-medium leading-[34px]">
                  {request}
                </p>
                <span className="text-[13.5px] text-muted-foreground">
                  on {origin}, run {runLink}
                  {gate2.run?.assetName === undefined ? '' : ` (${gate2.run.assetName})`}
                </span>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-3">
                {[
                  {
                    k: 'Intrusiveness',
                    v: (
                      <Chip tone="warn" icon="warn">
                        State-changing
                      </Chip>
                    ),
                  },
                  {
                    k: 'Environment',
                    v: (
                      <span className="inline-flex h-6 max-w-full items-center self-start truncate rounded-md border border-border-strong px-2 font-mono text-xs font-medium">
                        {origin}
                      </span>
                    ),
                  },
                  {
                    k: 'Reversal',
                    v: <span className="text-[13px] font-medium">Not recorded</span>,
                  },
                ].map((f) => (
                  <div
                    key={f.k}
                    className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-3.5 py-3"
                  >
                    <span className="text-xs text-muted-foreground">{f.k}</span>
                    {f.v}
                  </div>
                ))}
              </div>
              <WhyOutside gate2={gate2} />
              <AgentText label="Reason given by the agent (not verified)">
                {agentReason(gate2)}
              </AgentText>
              <Gate2Buttons gate2Id={gate2.id} open={open} size="lg" />
            </>
          ) : (
            <div role="status" className="flex flex-col items-start gap-4 pt-10">
              <span
                className={`flex size-14 items-center justify-center rounded-full ${closed === 'approved' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-text'}`}
              >
                <Icon name={closed === 'approved' ? 'check' : 'x'} size={24} />
              </span>
              <h2 className="m-0 text-[26px] font-semibold leading-[34px]">{done.title}</h2>
              <p className="m-0 max-w-[520px] text-sm leading-[23px] text-muted-foreground">
                {done.body}
              </p>
              <p className="m-0 text-[13px] text-muted-foreground">
                Decided by {gate2.decidedBy ?? 'the deadline'}.
                {gate2.decisionReason === null ? '' : ` Reason: ${gate2.decisionReason}`}
              </p>
              <p className="m-0 font-mono text-xs text-muted-foreground">
                {auditLine(gate2.audit)}
              </p>
              <LinkButton href={`/demo/runs/${gate2.runId}`}>Open the live run</LinkButton>
            </div>
          )}
        </div>
      </div>

      <div className="-mx-4 -my-5 flex min-h-[calc(100dvh-56px)] flex-col bg-bg md:hidden">
        <div className="h-1 bg-surface-2" aria-hidden="true">
          <div
            className="h-full transition-[width] duration-1000 ease-linear"
            style={{ width: `${(left / total) * 100}%`, backgroundColor: colour }}
          />
        </div>
        <div
          className="flex flex-col items-center gap-1 px-5 pt-6 text-center"
          role="timer"
          aria-live="off"
        >
          <span className="text-[13px] font-medium text-muted-foreground">
            Gate 2, {open ? label : 'Closed'}
          </span>
          <span
            className={`text-[76px] font-semibold leading-[84px] tabular-nums ${urgent ? 'motion-safe:animate-[bwpulse_1s_ease-in-out_infinite]' : ''}`}
            style={{ color: colour }}
          >
            {mmss(left)}
          </span>
          <span className="text-[13px] font-medium">
            {pending ? (
              <>
                No decision means <span className="text-bad">deny</span>
              </>
            ) : (
              <span className="capitalize">{closed}</span>
            )}
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-3 p-5">
          <div className="flex flex-col gap-1 rounded-2xl border border-border bg-card p-4">
            <span className="text-xs text-muted-foreground">{gate2.agent} wants to</span>
            <p className="m-0 break-words font-mono text-base font-medium leading-[22px]">
              {request}
            </p>
            <span className="text-[12.5px] text-muted-foreground">
              {origin}, run {runLink}
            </span>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip tone="warn">State-changing</Chip>
            </div>
          </div>
          <div className="rounded-2xl border border-dashed border-border-strong bg-code p-4">
            <p className="m-0 text-xs font-medium text-muted-foreground">
              Agent&apos;s reason (not verified)
            </p>
            <p className="m-0 mt-1.5 font-mono text-xs leading-5">{agentReason(gate2)}</p>
          </div>
          {pending ? null : (
            <div role="status" className="rounded-2xl border border-border bg-card p-4 text-[13px]">
              <p className="m-0 font-semibold">{done.title}</p>
              <p className="m-0 mt-1 text-muted-foreground">{done.body}</p>
              <p className="m-0 mt-2 break-all font-mono text-xs text-muted-foreground">
                {auditLine(gate2.audit)}
              </p>
            </div>
          )}
        </div>
        {pending ? (
          <div className="sticky bottom-0 border-t border-border bg-card px-5 pb-[30px] pt-4">
            <Gate2Buttons gate2Id={gate2.id} open={open} size="sheet" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
