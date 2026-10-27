import { Badge, cn } from '@blackwing/ui';

import {
  PAUSE_REASON_LABELS,
  phaseStatus,
  RUN_PHASES,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  RUN_TERMINAL_STATES,
} from '../../../../../lib/run-states';

import type { RunDetail } from '../../../../../lib/run-detail';
import type { ReactNode } from 'react';

/** The run state machine as ordered steps: done are checked, the current one is highlighted. */
export function RunStateTimeline({
  state,
  pauseReason,
}: Pick<RunDetail, 'state' | 'pauseReason'>): ReactNode {
  return (
    <nav aria-label="Run progress" data-testid="run-state-timeline" className="space-y-3">
      <ol className="flex flex-wrap gap-2">
        {RUN_PHASES.map((phase) => {
          const status = phaseStatus(phase, state);
          return (
            <li
              key={phase}
              data-phase={phase}
              data-status={status}
              aria-current={status === 'current' ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                status === 'current' &&
                  'border-primary bg-primary/10 font-semibold text-foreground',
                status === 'done' && 'border-border text-foreground',
                status === 'upcoming' && 'border-dashed border-border text-muted-foreground',
              )}
            >
              {status === 'done' && <span aria-hidden="true">✓</span>}
              <span>{RUN_STATE_LABELS[phase]}</span>
              {status === 'done' && <span className="sr-only"> (done)</span>}
              {phase === 'paused' && state === 'paused' && pauseReason !== null && (
                <Badge variant="warning" data-testid="pause-reason">
                  {PAUSE_REASON_LABELS[pauseReason]}
                </Badge>
              )}
            </li>
          );
        })}
      </ol>
      <ul
        aria-label="Terminal states"
        className="flex flex-wrap gap-2"
        data-testid="run-terminal-row"
      >
        {RUN_TERMINAL_STATES.map((terminal) => (
          <li
            key={terminal}
            data-phase={terminal}
            data-status={terminal === state ? 'current' : 'upcoming'}
            aria-current={terminal === state ? 'step' : undefined}
          >
            <Badge
              variant={terminal === state ? RUN_STATE_TONES[terminal] : 'outline'}
              className={terminal === state ? undefined : 'text-muted-foreground'}
            >
              {RUN_STATE_LABELS[terminal]}
            </Badge>
          </li>
        ))}
      </ul>
    </nav>
  );
}
