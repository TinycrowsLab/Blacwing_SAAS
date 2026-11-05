/* Presentational values (ring geometry) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// Gate 2 decision screen. The ring drains to zero; at zero the worker denies the request on its own.
import Link from 'next/link';

import { AgentText, Card, Chip, PageHeader } from './design';
import { Gate2Buttons, useGate2Clock } from './gate2-actions';
import { mmss, pathOf, shortId } from './run-model';

import type { gate2DetailSchema } from '../../app/demo/_lib/schemas';
import type { z } from 'zod';

const RADIUS = 120;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function Gate2View({ gate2 }: { readonly gate2: z.infer<typeof gate2DetailSchema> }) {
  const deadline = new Date(gate2.deadlineAt);
  const pending = gate2.status === 'pending';
  const { left, total } = useGate2Clock(gate2.deadlineAt, gate2.createdAt, pending);
  const open = pending && left > 0;
  const closed = pending && left === 0 ? 'expired' : gate2.status;
  const urgent = open && left < 60;
  let origin = gate2.url;
  try {
    origin = new URL(gate2.url).host;
  } catch {
    /* keep the raw url */
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[
          { label: 'Approvals', href: '/demo' },
          { label: 'Gate 2' },
          { label: `g2_${shortId(gate2.id)}` },
        ]}
        title="Runtime exception"
        chips={
          <Chip tone={open ? 'warn' : 'muted'} pill bordered={open}>
            {open ? 'Decision needed' : closed}
          </Chip>
        }
      />
      <Card as="div" className="grid lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-4 border-b border-border p-6 lg:border-b-0 lg:border-r">
          <div className="relative size-[270px] max-w-full">
            <svg viewBox="0 0 270 270" className="size-full -rotate-90" aria-hidden="true">
              <circle
                cx="135"
                cy="135"
                r={RADIUS}
                fill="none"
                strokeWidth="14"
                style={{ stroke: 'var(--surface-2)' }}
              />
              <circle
                cx="135"
                cy="135"
                r={RADIUS}
                fill="none"
                strokeWidth="14"
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - left / total)}
                style={{
                  stroke: urgent ? 'var(--bad)' : 'var(--text)',
                  transition: 'stroke-dashoffset 1s linear',
                }}
              />
            </svg>
            <div
              className="absolute inset-0 flex flex-col items-center justify-center"
              role="timer"
              aria-live="off"
            >
              <span className="text-xs text-muted-foreground">Auto-deny in</span>
              <span
                className={`text-6xl font-semibold tabular-nums ${urgent ? 'text-bad motion-safe:animate-pulse' : ''}`}
              >
                {mmss(left)}
              </span>
              <span className="text-xs text-muted-foreground">of {mmss(total)} allowed</span>
            </div>
          </div>
          <p className="m-0 text-center text-[13.5px]">
            If no one decides, this action is <span className="text-bad">denied automatically</span>
            .
          </p>
          <p className="m-0 text-xs text-muted-foreground">
            Deadline {deadline.toISOString().slice(11, 19)} UTC
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-4 p-6">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-muted-foreground">{gate2.agent} wants to</span>
            <h2 className="break-all font-mono text-2xl font-medium sm:text-3xl">
              {gate2.method} {pathOf(gate2.url).split('?')[0]}
            </h2>
            <span className="text-[13px] text-muted-foreground">
              on {origin}, run{' '}
              <Link
                href={`/demo/runs/${gate2.runId}`}
                className="font-mono text-primary hover:underline"
              >
                run_{shortId(gate2.runId)}
              </Link>
              {gate2.run?.assetName === undefined ? '' : ` (${gate2.run.assetName})`}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              {
                k: 'Intrusiveness',
                v: (
                  <Chip tone="warn" icon="warn">
                    State-changing
                  </Chip>
                ),
              },
              { k: 'Environment', v: <span className="font-mono text-[12.5px]">{origin}</span> },
              { k: 'Reversal', v: <span className="text-[13px] font-medium">Not recorded</span> },
            ].map((f) => (
              <div
                key={f.k}
                className="flex flex-col gap-1.5 rounded-xl border border-border p-3.5"
              >
                <span className="text-xs text-muted-foreground">{f.k}</span>
                {f.v}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-border p-4 text-[13px]">
            <h3 className="font-semibold">Why this is outside the authorisation</h3>
            <p className="m-0 flex flex-wrap items-center gap-2">
              <Chip tone="bad">ABOVE MAX</Chip>
              <span className="font-mono">{gate2.method}</span>
              <span className="text-muted-foreground">
                Runs are authorised for active-safe requests. State-changing needs a human.
              </span>
            </p>
            {gate2.whyOutside === '' ? null : (
              <p className="m-0 text-muted-foreground">{gate2.whyOutside}</p>
            )}
          </div>
          <AgentText label="Reason given by the agent (not verified)">
            {gate2.reason === '' ? '(none given)' : gate2.reason}
          </AgentText>
          {pending ? (
            <Gate2Buttons gate2Id={gate2.id} open={open} size="lg" />
          ) : (
            <p role="status" className="m-0 text-[13.5px]">
              Decision: <strong>{closed}</strong>.
              {closed === 'approved'
                ? ` Approval covers ${gate2.method} ${pathOf(gate2.url).split('?')[0]} for the rest of the run.`
                : ''}
            </p>
          )}
          <span className="text-xs text-muted-foreground">Recorded in the audit ledger</span>
        </div>
      </Card>
    </div>
  );
}
