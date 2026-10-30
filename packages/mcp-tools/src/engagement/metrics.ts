import { Counter, type Registry } from 'prom-client';

/** Engagement-tool metrics (MCP-012 observability); register once per registry. */
export interface EngagementMetrics {
  /** `mcp_dispatch_total{outcome}`: `accepted` or `rejected` by the Run Controller. */
  readonly dispatch: Counter<'outcome'>;
  /** `mcp_engagement_reads_total{tool}`: read calls to the engagement state. */
  readonly reads: Counter<'tool'>;
}

export function createEngagementMetrics(registry: Registry): EngagementMetrics {
  return {
    dispatch: new Counter({
      name: 'mcp_dispatch_total',
      help: 'dispatch_subtask answers from the Run Controller, by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    reads: new Counter({
      name: 'mcp_engagement_reads_total',
      help: 'Read calls made by the engagement tools, by tool.',
      labelNames: ['tool'],
      registers: [registry],
    }),
  };
}
