'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import {
  Badge,
  LoadingState,
  PermissionDenied,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@blackwing/ui';

import {
  formatHaltMs,
  isRetryableKillError,
  KILL_SCOPE_LABELS,
  MAX_STATUS_RETRIES,
  retryDelayMs,
} from './kill-model';
import { isApiError } from '../../lib/api-error';
import { createTenantKillApi, tenantKillKeys, type TenantKillApi } from '../../lib/tenant-kill-api';

import type { KillEventView } from '@blackwing/contracts';

const HTTP_FORBIDDEN = 403;
const META = { suppressGlobalError: true } as const;

export interface KillHistoryTableProps {
  /** Test seam; defaults to the console's kill client. */
  readonly api?: TenantKillApi;
}

function statusVariant(
  status: KillEventView['status'],
): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'halted') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'partially_halted') return 'warning';
  return 'default';
}

/**
 * The tenant's kill history (`/settings/safety/kill-events`): newest first, with the server's measured
 * halt time. Another tenant's kills never reach the page, because the API lists the session's tenant only.
 */
export function KillHistoryTable({ api }: KillHistoryTableProps): ReactNode {
  const [client] = useState(() => api ?? createTenantKillApi());
  const history = useQuery({
    queryKey: tenantKillKeys.events,
    queryFn: ({ signal }) => client.events(signal),
    retry: (failureCount, error) =>
      isRetryableKillError(isApiError(error) ? error.status : undefined) &&
      failureCount < MAX_STATUS_RETRIES,
    retryDelay: (failureCount) => retryDelayMs(failureCount),
    meta: META,
  });

  if (isApiError(history.error) && history.error.status === HTTP_FORBIDDEN) {
    return <PermissionDenied permission="run:read" contact="a tenant administrator" />;
  }
  if (history.isPending) return <LoadingState variant="table" label="Loading kill history" />;
  if (history.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        Kill history is unavailable. Try again shortly.
      </p>
    );
  }
  if (history.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No stop has been requested yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table aria-label="Kill history">
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Halt time</TableHead>
            <TableHead>Triggered</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.data.map((event) => (
            <TableRow key={event.killEventId} data-kill-event={event.killEventId}>
              <TableCell>{KILL_SCOPE_LABELS[event.scope]}</TableCell>
              <TableCell className="font-mono text-xs">{event.actorRef}</TableCell>
              <TableCell>
                <Badge variant={statusVariant(event.status)}>
                  {event.status.replace('_', ' ')}
                </Badge>
              </TableCell>
              <TableCell className="tabular-nums">{formatHaltMs(event.haltMs)}</TableCell>
              <TableCell>
                <time dateTime={event.triggeredAt}>{event.triggeredAt}</time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
