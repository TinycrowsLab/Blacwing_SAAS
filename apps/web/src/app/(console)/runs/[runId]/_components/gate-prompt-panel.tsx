'use client';

import Link from 'next/link';
import * as React from 'react';

import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@blackwing/ui';

import {
  canActAtGate,
  formatRemaining,
  GATES,
  LAST_GATE,
  gate2Countdown,
  gateRoleLabel,
  isOwnGate1Request,
  visibleGates,
  type GateNumber,
  type GateRunState,
  type PendingGate,
} from './gate-model';
import { emitClientEvent } from '../../../../../lib/client-events';

import type { IntrusivenessClass, RunEvent } from '@blackwing/contracts';
import type { ReactNode } from 'react';

const TICK_MS = 1000;

export interface GatePromptPanelProps {
  /** Public run id (`run_…`), used in the deep links. */
  readonly runId: string;
  readonly run: GateRunState;
  /** Pending-gate data from `useRun` (the `gate_decisions` rows); stream events override it. */
  readonly gates?: readonly PendingGate[];
  /** Run events from the stream; `gate.pending` / `gate.decided` show and hide gates live. */
  readonly events?: readonly RunEvent[];
  /** Roles of the signed-in user; cosmetic, the server enforces authz and SoD (§8.4, §8.11). */
  readonly roles: readonly string[];
  readonly currentUserId: string | null;
  /** Who requested the run's plan (Gate 1 separation of duties). */
  readonly requesterId: string | null;
  /** Gate 1 summary of the pending plan. */
  readonly plan?: {
    readonly testCaseCount: number;
    readonly classes: readonly IntrusivenessClass[];
  };
  /** Gate 3: confirmed findings awaiting release. */
  readonly confirmedFindingCount?: number;
  /** Server clock minus client clock in ms, measured when the run was fetched. */
  readonly serverOffsetMs?: number;
}

/** Inline prompt for runs waiting at a human gate. It only links to the owning flows and never decides. */
export function GatePromptPanel({
  events = [],
  gates = [],
  run,
  ...rest
}: GatePromptPanelProps): ReactNode {
  const shown = visibleGates(run, gates, events);
  const seen = React.useRef(new Set<GateNumber>());
  const shownKey = shown.map((g) => g.gate).join(',');
  React.useEffect(() => {
    for (const gate of GATES.filter((g) => shownKey.split(',').includes(String(g)))) {
      if (seen.current.has(gate)) continue;
      seen.current.add(gate);
      emitClientEvent('gate_panel_rendered', '/runs/:id', { runId: rest.runId, gate });
    }
  }, [shownKey, rest.runId]);
  if (shown.length === 0) return null;
  return (
    <div className="grid gap-3" data-testid="gate-prompts">
      {shown.map((gate) => (
        <GateCard key={gate.gate} gate={gate} {...rest} />
      ))}
    </div>
  );
}

type CardProps = Omit<GatePromptPanelProps, 'run' | 'gates' | 'events'> & {
  readonly gate: PendingGate;
};

function GateCard({ gate, roles, ...rest }: CardProps): ReactNode {
  const can = canActAtGate(roles, gate.gate);
  const title = {
    1: 'Plan approval (Gate 1)',
    2: 'Runtime exception (Gate 2)',
    3: 'Triage and release (Gate 3)',
  }[gate.gate];
  return (
    <Card role="region" aria-label={title} data-gate={gate.gate}>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <Badge variant="warning">Waiting for a human</Badge>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <GateBody gate={gate} can={can} {...rest} />
      </CardContent>
    </Card>
  );
}

function GateBody({ gate, ...props }: BodyProps & { readonly gate: PendingGate }): ReactNode {
  switch (gate.gate) {
    case 1:
      return <Gate1Body {...props} />;
    case 2:
      return <Gate2Body gate={gate} {...props} />;
    case LAST_GATE:
      return <Gate3Body {...props} />;
  }
}

type BodyProps = Omit<CardProps, 'gate' | 'roles'> & { readonly can: boolean };

function OwnerLink({
  can,
  gate,
  href,
  label,
}: {
  readonly can: boolean;
  readonly gate: GateNumber;
  readonly href: string;
  readonly label: string;
}): ReactNode {
  if (!can) {
    return <p className="text-muted-foreground">Waiting on {gateRoleLabel(gate)}.</p>;
  }
  return (
    <Button asChild className="w-fit">
      <Link href={href}>{label}</Link>
    </Button>
  );
}

function Gate1Body({ can, runId, plan, requesterId, currentUserId }: BodyProps): ReactNode {
  const own = isOwnGate1Request(requesterId, currentUserId);
  const href = `/runs/${encodeURIComponent(runId)}/plan`;
  return (
    <>
      {plan === undefined ? (
        <p>A test plan is waiting for approval.</p>
      ) : (
        <p>
          {plan.testCaseCount} test case{plan.testCaseCount === 1 ? '' : 's'}
          {plan.classes.length > 0 ? `, intrusiveness: ${plan.classes.join(', ')}` : ''}.
        </p>
      )}
      {can && own ? (
        <>
          <Button disabled className="w-fit">
            Review and approve plan
          </Button>
          <p role="note" className="text-muted-foreground">
            Awaiting a different approver (separation of duties).
          </p>
        </>
      ) : (
        <OwnerLink can={can} gate={1} href={href} label="Review and approve plan" />
      )}
    </>
  );
}

function Gate3Body({ can, runId, confirmedFindingCount }: BodyProps): ReactNode {
  const n = confirmedFindingCount;
  return (
    <>
      <p>
        {n === undefined
          ? 'Confirmed findings are waiting for release.'
          : `${String(n)} confirmed finding${n === 1 ? '' : 's'} awaiting release.`}
      </p>
      <OwnerLink
        can={can}
        gate={3}
        href={`/runs/${encodeURIComponent(runId)}/triage`}
        label="Triage and release"
      />
    </>
  );
}

function Gate2Body({
  gate,
  can,
  runId,
  serverOffsetMs = 0,
}: BodyProps & { readonly gate: PendingGate }): ReactNode {
  const [now, setNow] = React.useState(() => Date.now());
  const wasRunning = React.useRef(false);
  const countdown = gate2Countdown(gate.timeoutAt, now, serverOffsetMs, wasRunning.current);
  if (countdown.kind === 'running') wasRunning.current = true;
  const live = countdown.kind === 'running';
  React.useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [live]);

  const when =
    gate.timeoutAt === null || gate.timeoutAt === undefined
      ? null
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(
          new Date(gate.timeoutAt),
        );
  return (
    <>
      <p>
        The agent wants an action outside its permitted envelope
        {gate.subject ? (
          <>
            : <span className="font-mono">{gate.subject}</span>
          </>
        ) : null}
        .
      </p>
      {countdown.kind === 'running' ? (
        <p>
          <span className="font-mono text-lg font-semibold" role="timer" aria-label="Time left">
            {formatRemaining(countdown.remainingMs)}
          </span>
        </p>
      ) : null}
      {countdown.kind === 'timed_out' ? (
        <p role="alert" className="font-semibold text-danger">
          Denied (timed out). This action will be denied; waiting for the run to confirm.
        </p>
      ) : null}
      {countdown.kind === 'expired' ? (
        <p role="alert" className="font-semibold text-danger">
          Expired — denied.
        </p>
      ) : null}
      {when === null ? (
        <p className="text-muted-foreground">No decision before the timeout denies this action.</p>
      ) : (
        <p className="text-muted-foreground" suppressHydrationWarning>
          No decision by {when} denies this action.
        </p>
      )}
      {countdown.kind === 'expired' || countdown.kind === 'timed_out' ? null : (
        <OwnerLink
          can={can}
          gate={2}
          href={`/runs/${encodeURIComponent(runId)}/gate2`}
          label="Decide on this action"
        />
      )}
    </>
  );
}
