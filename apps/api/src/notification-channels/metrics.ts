import { Counter, type Registry } from 'prom-client';

/** Channel-API metrics (NOTIFY-001 observability). Labels are the bounded kind and op sets, never a channel id. */
export interface NotificationChannelMetrics {
  /** Counts committed channel changes only; no-op requests do not count. */
  changed(kind: string, op: string): void;
}

/** `bw_notification_channel_changes_total{kind,op}` on the app's registry. */
export function createNotificationChannelMetrics(registry: Registry): NotificationChannelMetrics {
  const counter = new Counter({
    name: 'bw_notification_channel_changes_total',
    help: 'Notification channel changes committed, by kind and operation.',
    labelNames: ['kind', 'op'] as const,
    registers: [registry],
  });
  return {
    changed: (kind, op) => {
      counter.inc({ kind, op });
    },
  };
}
