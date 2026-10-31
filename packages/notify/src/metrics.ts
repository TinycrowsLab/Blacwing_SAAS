import { Counter, type Registry } from 'prom-client';

/** `notify()` counters (NOTIFY-002 observability). Labels are the bounded event and kind sets, never a tenant or channel id. */
export interface NotifyMetrics {
  /** A request reached the core (before routing). */
  requested(event: string): void;
  /** A request matched no channel and no fallback, so nothing was enqueued. */
  unrouted(): void;
  /** One delivery row was written to the outbox for a channel of `kind`. */
  enqueued(kind: string): void;
  /** Routing rules matched a request of `event` (counted per matching rule). */
  routesResolved(event: string, matched: number): void;
  /** A critical request of `event` fell back to the tenant's admins because no rule or channel delivered it. */
  fallbackUsed(event: string): void;
}

/** A metrics sink that counts nothing; the default when no registry is wired. */
export const NOOP_NOTIFY_METRICS: NotifyMetrics = {
  requested: () => undefined,
  unrouted: () => undefined,
  enqueued: () => undefined,
  routesResolved: () => undefined,
  fallbackUsed: () => undefined,
};

/** `notifications_requested_total{event}`, `notifications_unrouted_total`, `notifications_enqueued_total{kind}` on `registry`. */
export function createNotifyMetrics(registry: Registry): NotifyMetrics {
  const requested = new Counter({
    name: 'notifications_requested_total',
    help: 'Notification requests received by the notify core, by event.',
    labelNames: ['event'] as const,
    registers: [registry],
  });
  const unrouted = new Counter({
    name: 'notifications_unrouted_total',
    help: 'Notification requests that matched no channel and no fallback.',
    registers: [registry],
  });
  const enqueued = new Counter({
    name: 'notifications_enqueued_total',
    help: 'Notification deliveries enqueued to the outbox, by channel kind.',
    labelNames: ['kind'] as const,
    registers: [registry],
  });
  const routesResolved = new Counter({
    name: 'routes_resolved_total',
    help: 'Notification routing rules that matched a request, by event.',
    labelNames: ['event'] as const,
    registers: [registry],
  });
  const fallbackUsed = new Counter({
    name: 'routes_fallback_used_total',
    help: 'Critical notification requests that fell back to the tenant admins, by event.',
    labelNames: ['event'] as const,
    registers: [registry],
  });
  return {
    routesResolved: (event, matched) => {
      if (matched > 0) routesResolved.inc({ event }, matched);
    },
    fallbackUsed: (event) => {
      fallbackUsed.inc({ event });
    },
    requested: (event) => {
      requested.inc({ event });
    },
    unrouted: () => {
      unrouted.inc();
    },
    enqueued: (kind) => {
      enqueued.inc({ kind });
    },
  };
}
