'use client';

import Link from 'next/link';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  ErrorState,
  NotFound,
} from '@blackwing/ui';

import { RunDetailHeader, type RunDetailHeaderProps } from './run-detail-header';
import { RunStateTimeline } from './run-state-timeline';
import { useRun } from './use-run';
import { KillControl } from '../../../../../components/kill/kill-control';
import { isApiError } from '../../../../../lib/api-error';

import type { RunDetail } from '../../../../../lib/run-detail';
import type { ReactNode } from 'react';

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;

export interface RunDetailViewProps {
  readonly runId: string;
  readonly initialRun: RunDetail;
  readonly streamConnected?: boolean;
  readonly killSlot?: RunDetailHeaderProps['killSlot'];
  /** Roles of the signed-in user; with them the page mounts the run's kill control (F33). */
  readonly roles?: readonly string[];
  /** Slots the live-run components mount into (LIVERUN-004 to 009). */
  readonly activity?: ReactNode;
  readonly testCases?: ReactNode;
  readonly gates?: ReactNode;
  readonly findings?: ReactNode;
}

function Slot({ name, title, children }: { name: string; title: string; children?: ReactNode }) {
  return (
    <section aria-label={title} data-slot={name} className="rounded-lg border border-border p-4">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children ?? <p className="text-sm text-muted-foreground">Nothing here yet.</p>}
    </section>
  );
}

export function RunDetailView({
  runId,
  initialRun,
  streamConnected,
  killSlot,
  roles,
  activity,
  testCases,
  gates,
  findings,
}: RunDetailViewProps): ReactNode {
  const { run, error, updatedAt } = useRun(runId, {
    initialData: initialRun,
    ...(streamConnected === undefined ? {} : { streamConnected }),
  });
  // The run vanished or became invisible: fail closed, never keep showing the last known copy.
  if (isApiError(error) && (error.status === HTTP_NOT_FOUND || error.status === HTTP_FORBIDDEN)) {
    return <NotFound />;
  }
  if (run === undefined) return <ErrorState error={isApiError(error) ? error : {}} />;
  // The run's kill control (F33): hidden for a role that may not stop runs and once the run is terminal.
  const killControl =
    killSlot ??
    (roles === undefined
      ? undefined
      : ({ terminal }: { terminal: boolean }) =>
          terminal ? null : <KillControl scope="run" scopeRefId={run.id} roles={roles} />);
  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/runs">Runs</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{run.publicId}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <RunDetailHeader
        run={run}
        updatedAt={updatedAt}
        {...(killControl ? { killSlot: killControl } : {})}
      />
      <RunStateTimeline state={run.state} pauseReason={run.pauseReason} />
      <nav aria-label="Run views" className="text-sm">
        <Link
          href={`/runs/${run.publicId}/surface`}
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View attack surface
        </Link>
      </nav>
      {error !== null && (
        <p role="status" className="text-sm text-warning" data-testid="run-stale-warning">
          Live refresh is failing; the state shown may be out of date.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <Slot name="activity" title="Activity">
            {activity}
          </Slot>
          <Slot name="testCases" title="Test cases">
            {testCases}
          </Slot>
        </div>
        <div className="space-y-4">
          <Slot name="gates" title="Gates">
            {gates}
          </Slot>
          <Slot name="findings" title="Findings">
            {findings}
          </Slot>
        </div>
      </div>
    </div>
  );
}
