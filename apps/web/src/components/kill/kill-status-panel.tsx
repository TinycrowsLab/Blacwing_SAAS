'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';

import { isKillOpen, type KillEventView } from '@blackwing/contracts';
import { Button, LoadingState } from '@blackwing/ui';

import {
  formatHaltMs,
  isRetryableKillError,
  KILL_SCOPE_LABELS,
  killPollInterval,
  killTimeline,
  MAX_STATUS_RETRIES,
  retryDelayMs,
  type StageState,
} from './kill-model';
import { isApiError } from '../../lib/api-error';
import { createTenantKillApi, tenantKillKeys, type TenantKillApi } from '../../lib/tenant-kill-api';

const HTTP_FORBIDDEN = 403;
const META = { suppressGlobalError: true } as const;

export interface KillStatusPanelProps {
  readonly killEventId: string;
  /** Test seam; defaults to the console's kill client. */
  readonly api?: TenantKillApi;
  /** Called when the operator starts another stop, once this kill has settled. */
  readonly onReset: () => void;
}

const HEADLINE: Readonly<Record<KillEventView['status'], string>> = {
  initiated: 'Stopping now',
  propagating: 'Stopping now',
  halted: 'All testing stopped',
  partially_halted: 'Stop only partly completed',
  failed: 'Stop failed',
};

const STAGE_COPY: Readonly<Record<StageState, (atMs: number | null) => string>> = {
  confirmed: (atMs) => `Confirmed at ${formatHaltMs(atMs)}`,
  pending: () => 'Waiting for confirmation',
  degraded: () => 'Not confirmed: still running',
  not_needed: () => 'Nothing in scope to stop',
};

/**
 * Live progress of one kill (F33, §8.5): the §8.5 stages as the server confirmed them and the halt time
 * it measured. It polls `GET /v1/kill/{id}` every second while the kill is open, shows a stale marker
 * (not a guess) when a read fails, and never reports a halt the server has not recorded.
 */
export function KillStatusPanel({ killEventId, api, onReset }: KillStatusPanelProps): ReactNode {
  const [client] = useState(() => api ?? createTenantKillApi());
  const titleId = useId();
  const query = useQuery({
    queryKey: tenantKillKeys.event(killEventId),
    queryFn: ({ signal }) => client.event(killEventId, signal),
    refetchInterval: (state) => killPollInterval(state.state.data?.status),
    retry: (failureCount, error) =>
      isRetryableKillError(isApiError(error) ? error.status : undefined) &&
      failureCount < MAX_STATUS_RETRIES,
    retryDelay: (failureCount) => retryDelayMs(failureCount),
    meta: META,
  });

  const event = query.data;
  if (event === undefined) {
    if (query.isError) {
      const forbidden = isApiError(query.error) && query.error.status === HTTP_FORBIDDEN;
      return (
        <p role="alert" className="text-sm font-medium text-danger">
          {forbidden
            ? 'You are not permitted to read this stop.'
            : 'The stop status is unavailable. It has not been confirmed. Retrying.'}
        </p>
      );
    }
    return <LoadingState label="Waiting for the stop to be confirmed" />;
  }

  const open = isKillOpen(event.status);
  const ended = event.status === 'partially_halted' || event.status === 'failed';
  const stages = killTimeline(event);

  return (
    <section
      aria-labelledby={titleId}
      data-kill-status={event.status}
      className="grid gap-4 rounded-md border border-border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            {HEADLINE[event.status]}
          </h2>
          <p className="text-sm text-muted-foreground">{KILL_SCOPE_LABELS[event.scope]} scope</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Halt time</p>
          <p className="text-3xl font-semibold tabular-nums" data-testid="kill-halt-ms">
            {formatHaltMs(event.haltMs)}
          </p>
        </div>
      </div>

      <ol aria-label="Halt timeline" className="grid gap-2">
        {stages.map((stage) => (
          <li
            key={stage.key}
            data-stage={stage.key}
            data-state={stage.state}
            className="flex justify-between gap-4 text-sm"
          >
            <span>{stage.label}</span>
            <span
              className={
                stage.state === 'degraded'
                  ? 'font-medium text-danger tabular-nums'
                  : 'tabular-nums text-muted-foreground'
              }
            >
              {STAGE_COPY[stage.state](stage.atMs)}
            </span>
          </li>
        ))}
      </ol>

      {ended && (
        <p role="alert" className="text-sm font-medium text-danger">
          Some stages did not confirm. Treat the affected work as still running and escalate to a
          platform administrator.
        </p>
      )}

      {query.isError && (
        <p role="status" className="text-sm text-warning" data-testid="kill-stale">
          Live status is retrying; the status shown may be out of date.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-xs text-muted-foreground">Stop {killEventId}</p>
        {!open && (
          <Button variant="outline" onClick={onReset}>
            Start another stop
          </Button>
        )}
      </div>
    </section>
  );
}
