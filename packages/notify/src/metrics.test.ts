import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { createNotifyMetrics, NOOP_NOTIFY_METRICS } from './metrics.js';

describe('notify metrics', () => {
  it('counts requests by event, unrouted requests and enqueued deliveries by kind', async () => {
    const registry = new Registry();
    const metrics = createNotifyMetrics(registry);
    metrics.requested('kill.fired');
    metrics.requested('kill.fired');
    metrics.unrouted();
    metrics.enqueued('email');
    const text = await registry.metrics();
    expect(text).toMatch(/notifications_requested_total\{event="kill\.fired"\} 2/);
    expect(text).toMatch(/notifications_unrouted_total 1/);
    expect(text).toMatch(/notifications_enqueued_total\{kind="email"\} 1/);
  });

  it('the default sink counts nothing and never throws', () => {
    expect(() => {
      NOOP_NOTIFY_METRICS.requested('run.failed');
      NOOP_NOTIFY_METRICS.unrouted();
      NOOP_NOTIFY_METRICS.enqueued('email');
    }).not.toThrow();
  });

  it('refuses a second registration of the same metric names on one registry', () => {
    const registry = new Registry();
    createNotifyMetrics(registry);
    expect(() => createNotifyMetrics(registry)).toThrow();
  });
});
