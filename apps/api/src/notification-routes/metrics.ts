import { Counter, type Registry } from 'prom-client';

/** Routing-rule API metrics (NOTIFY-011 observability). Labels are the bounded op set, never a rule or channel id. */
export interface NotificationRouteMetrics {
  /** Counts committed rule changes only; no-op requests do not count. */
  changed(op: string): void;
}

/** `bw_notification_route_changes_total{op}` on the app's registry. */
export function createNotificationRouteMetrics(registry: Registry): NotificationRouteMetrics {
  const counter = new Counter({
    name: 'bw_notification_route_changes_total',
    help: 'Notification routing rule changes committed, by operation.',
    labelNames: ['op'] as const,
    registers: [registry],
  });
  return {
    changed: (op) => {
      counter.inc({ op });
    },
  };
}
