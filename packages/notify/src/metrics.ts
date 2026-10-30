import { Counter, type Registry } from 'prom-client';

/** `notify()` counters (NOTIFY-002 observability). Labels are the bounded event and kind sets, never a tenant or channel id. */
export interface NotifyMetrics {
  /** A request reached the core (before routing). */
  requested(event: string): void;
  /** A request matched no channel and no fallback, so nothing was enqueued. */
  unrouted(): void;
  /** One delivery row was written to the outbox for a channel of `kind`. */
  enqueued(kind: string): void;
}

/** A metrics sink that counts nothing; the default when no registry is wired. */
export const NOOP_NOTIFY_METRICS: NotifyMetrics = {
  requested: () => undefined,
  unrouted: () => undefined,
  enqueued: () => undefined,
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
  return {
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
