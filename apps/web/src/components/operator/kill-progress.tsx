import {
  KILL_PHASES,
  KILL_SLA_GATEWAY_MS,
  KILL_SLA_SANDBOX_MS,
  isKillOpen,
  killFailedComponents,
  killSlaBreaches,
  type OperatorKillEventDetail,
} from '@blackwing/contracts';

import type { ReactNode } from 'react';

const MS_PER_SECOND = 1000;

/** `3.3 s`: one decimal, as the halt-time design shows it. */
export function formatSeconds(ms: number): string {
  return `${(ms / MS_PER_SECOND).toFixed(1)} s`;
}

/**
 * The halt as the kill path measured it (§8.5): each phase shows only once the path confirmed it, the
 * headline says "stopped" only for status `halted`, and a partial or failed kill names what is still
 * running. Nothing here is inferred from elapsed time.
 */
export function KillProgress({ event }: { readonly event: OperatorKillEventDetail }): ReactNode {
  const open = isKillOpen(event.status);
  const breaches = killSlaBreaches(event);
  const failed = killFailedComponents(event.affected);
  const nothingRunning = event.status === 'halted' && event.haltMs === 0;
  const fired = Date.parse(event.firedAt);

  const headline =
    event.status === 'halted'
      ? 'All testing stopped'
      : open
        ? 'Stopping now'
        : 'Kill only partly completed';

  return (
    <section
      aria-labelledby="kill-progress-title"
      className="grid gap-4 rounded-md border border-border p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="kill-progress-title" className="text-lg font-semibold">
            {headline}
          </h2>
          <p className="text-sm text-muted-foreground">
            {event.scope === 'global'
              ? 'Everything on the platform'
              : `Tenant ${event.tenantId ?? ''}`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Total halt time</p>
          <p className="text-3xl font-semibold tabular-nums" data-testid="halt-time">
            {event.haltMs === null ? 'Measuring' : formatSeconds(event.haltMs)}
          </p>
        </div>
      </div>

      {nothingRunning ? (
        <p className="text-sm">Nothing in scope was running, so there was nothing to stop.</p>
      ) : (
        <ol className="grid gap-2" aria-label="Halt phases">
          {KILL_PHASES.map((phase) => {
            const at = event[phase.field];
            return (
              <li key={phase.key} className="flex justify-between text-sm" data-phase={phase.key}>
                <span>{phase.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {at === null
                    ? 'Waiting for confirmation'
                    : `Confirmed at ${formatSeconds(Date.parse(at) - fired)}`}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {breaches.gateway && (
        <p role="alert" className="text-sm font-medium text-danger">
          The gateway block was slower than the {formatSeconds(KILL_SLA_GATEWAY_MS)} target.
        </p>
      )}
      {breaches.sandboxes && (
        <p role="alert" className="text-sm font-medium text-danger">
          Sandbox termination was slower than the {formatSeconds(KILL_SLA_SANDBOX_MS)} target.
        </p>
      )}

      {!open && event.status !== 'halted' && (
        <div role="alert" className="grid gap-1 text-sm text-danger">
          <p className="font-medium">
            Some components did not stop. Treat the affected work as still running.
          </p>
          {failed.length > 0 ? (
            <ul className="list-disc pl-5">
              {failed.map((component) => (
                <li key={`${component.kind}:${component.id}`}>
                  {component.kind} {component.id}
                </li>
              ))}
            </ul>
          ) : (
            <p>The kill path did not confirm every component.</p>
          )}
        </div>
      )}
      <p className="font-mono text-xs text-muted-foreground">Kill event {event.id}</p>
    </section>
  );
}
