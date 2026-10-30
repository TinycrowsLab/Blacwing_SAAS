import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { createDashboardMetrics } from './metrics.js';

describe('createDashboardMetrics', () => {
  it('records the read duration and the row count per GraphQL query, on the app registry', async () => {
    const registry = new Registry();
    const metrics = createDashboardMetrics(registry);
    metrics.observe('summary', 12, 6);

    const text = await registry.metrics();
    expect(text).toContain('graphql_dashboard_query_duration_ms_count{query="summary"} 1');
    expect(text).toContain('graphql_dashboard_rows_count{query="summary"} 1');
    expect(text).toContain('graphql_dashboard_rows_sum{query="summary"} 6');
  });

  it('labels only with the bounded query name, never with an id', async () => {
    const registry = new Registry();
    createDashboardMetrics(registry).observe('connection', 3, 0);

    const text = await registry.metrics();
    const labelled = text.split('\n').filter((line) => line.startsWith('graphql_dashboard_'));
    expect(labelled.length).toBeGreaterThan(0);
    for (const line of labelled) {
      expect(line).toMatch(/\{(le="[^"]+",)?query="connection"\}/);
    }
  });
});
