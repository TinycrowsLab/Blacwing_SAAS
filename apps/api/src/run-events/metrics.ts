import { Counter, Gauge, type Registry } from 'prom-client';

/** Run event stream metrics (#65), on the app's registry. Tenants appear only as a hash (§8.7). */
export interface RunEventsMetrics {
  /** A stream opened for a tenant. */
  connectionOpened(tenantHash: string): void;
  /** A stream closed for a tenant, for any reason. */
  connectionClosed(tenantHash: string): void;
  /** One run event written to a stream. */
  eventSent(): void;
  /** Events dropped for a slow consumer (counted from the subscription's gap markers). */
  dropped(count: number): void;
  /** A stream answered `resync` (events trimmed, a slow consumer, or a replay over the cap). */
  resync(reason: string): void;
}

export function createRunEventsMetrics(registry: Registry): RunEventsMetrics {
  const active = new Gauge({
    name: 'sse_connections_active',
    help: 'Open run event streams, by tenant hash.',
    labelNames: ['tenant'],
    registers: [registry],
  });
  const sent = new Counter({
    name: 'sse_events_sent_total',
    help: 'Run events written to event streams.',
    registers: [registry],
  });
  const resyncs = new Counter({
    name: 'sse_resync_total',
    help: 'Event streams that told the client to refetch, by reason.',
    labelNames: ['reason'],
    registers: [registry],
  });
  const dropped = new Counter({
    name: 'sse_dropped_total',
    help: 'Run events dropped for slow event stream consumers.',
    registers: [registry],
  });
  return {
    connectionOpened: (tenant) => {
      active.inc({ tenant });
    },
    connectionClosed: (tenant) => {
      active.dec({ tenant });
    },
    eventSent: () => {
      sent.inc();
    },
    dropped: (count) => {
      dropped.inc(count);
    },
    resync: (reason) => {
      resyncs.inc({ reason });
    },
  };
}
