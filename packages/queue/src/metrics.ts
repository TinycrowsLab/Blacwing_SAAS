import { metrics } from '@opentelemetry/api';

/** Gauge values for one queue, sampled from Valkey. */
export interface QueueGaugeSample {
  readonly active: number;
  readonly waiting: number;
  /** Waiting plus delayed jobs. */
  readonly depth: number;
}

/**
 * Metrics port of the queue factory. Tests pass an in-memory implementation; the default is the OTel
 * adapter below, which the Prometheus exporter serves.
 */
export interface QueueMetrics {
  /** A job finished successfully (`bull_jobs_completed_total{queue}`). */
  readonly completed: (queue: string) => void;
  /** A job failed terminally, after its attempts (`bull_jobs_failed_total{queue}`). */
  readonly failed: (queue: string) => void;
  /** The latest sampled gauges for a queue (`bull_jobs_active`, `bull_jobs_waiting`, `bull_queue_depth`). */
  readonly sampled: (queue: string, sample: QueueGaugeSample) => void;
}

/** OTel adapter: counters and observable gauges on the `@blackwing/queue` meter. */
export function createOtelQueueMetrics(): QueueMetrics {
  const meter = metrics.getMeter('@blackwing/queue');
  const completed = meter.createCounter('bull_jobs_completed_total', {
    description: 'BullMQ jobs that completed successfully, by queue',
  });
  const failed = meter.createCounter('bull_jobs_failed_total', {
    description:
      'BullMQ jobs that failed terminally after all attempts, by queue (alert on any increase)',
  });
  const latest = new Map<string, QueueGaugeSample>();
  const gauge = (
    name: string,
    description: string,
    pick: (s: QueueGaugeSample) => number,
  ): void => {
    meter.createObservableGauge(name, { description }).addCallback((result) => {
      for (const [queue, sample] of latest) result.observe(pick(sample), { queue });
    });
  };
  gauge('bull_jobs_active', 'Jobs currently being processed, by queue', (s) => s.active);
  gauge('bull_jobs_waiting', 'Jobs waiting to be picked up, by queue', (s) => s.waiting);
  gauge('bull_queue_depth', 'Waiting plus delayed jobs, by queue', (s) => s.depth);
  return {
    completed: (queue) => {
      completed.add(1, { queue });
    },
    failed: (queue) => {
      failed.add(1, { queue });
    },
    sampled: (queue, sample) => {
      latest.set(queue, sample);
    },
  };
}
