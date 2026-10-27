'use client';

import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@blackwing/ui';

import {
  formatMs,
  GATEWAY_SLO_MS,
  isWithinHaltSlo,
  SANDBOX_SLO_MS,
  totalHaltMs,
  type KillEventView,
} from './kill-model';

import type { ReactNode } from 'react';

function stage(label: string, ms: number | null, sloMs: number): string {
  return ms === null
    ? `${label}: not reported`
    : `${label}: ${formatMs(ms)} (target under ${formatMs(sloMs)})`;
}

/**
 * The measured, audited halt time of a kill (F33, §8.5). It renders only from a completed server
 * `kill_events` record and never estimates: no `completedAt` means nothing is shown. Green when both the
 * gateway and sandbox stages met their SLO, amber otherwise (including a partial or failed halt).
 */
export function HaltTimeBadge({
  killEvent,
}: {
  readonly killEvent: KillEventView | null;
}): ReactNode {
  if (killEvent === null) return null;
  const total = totalHaltMs(killEvent);
  if (total === null) return null;
  const withinSlo = isWithinHaltSlo(killEvent);
  const label =
    killEvent.status === 'halted'
      ? `Halted in ${formatMs(total)}`
      : `Halt incomplete after ${formatMs(total)}`;
  return (
    <TooltipProvider>
      <div className="inline-flex items-center gap-2" data-testid="halt-time">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant={withinSlo ? 'success' : 'warning'}
              tabIndex={0}
              data-slo={withinSlo ? 'within' : 'over'}
            >
              {label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p>{stage('Egress gateway blocked', killEvent.gatewayBlockedMs, GATEWAY_SLO_MS)}</p>
            <p>{stage('Sandboxes terminated', killEvent.sandboxesTerminatedMs, SANDBOX_SLO_MS)}</p>
          </TooltipContent>
        </Tooltip>
        {killEvent.actor === null ? null : (
          <span className="text-xs text-muted-foreground">by {killEvent.actor}</span>
        )}
      </div>
    </TooltipProvider>
  );
}
