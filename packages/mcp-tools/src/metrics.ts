import { Counter, exponentialBuckets, Histogram, Registry } from 'prom-client';

/** MCP tool metrics (MCP-001 observability). One registry per runtime; the host scrapes or forwards it. */
export interface ToolMetrics {
  readonly registry: Registry;
  /** `mcp_tool_calls_total{server,tool,result}`: `result` is `ok` or the stable tool error code. */
  readonly calls: Counter<'server' | 'tool' | 'result'>;
  /** `mcp_tool_latency_ms{server,tool}`. */
  readonly latency: Histogram<'server' | 'tool'>;
  /** `mcp_tool_output_truncated_total{server,tool}`. */
  readonly truncated: Counter<'server' | 'tool'>;
}

const FIRST_BUCKET_MS = 5;
const BUCKET_FACTOR = 2;
const BUCKET_COUNT = 14; // 5 ms to about 41 s
const LATENCY_BUCKETS_MS = exponentialBuckets(FIRST_BUCKET_MS, BUCKET_FACTOR, BUCKET_COUNT);

export function createToolMetrics(registry: Registry = new Registry()): ToolMetrics {
  return {
    registry,
    calls: new Counter({
      name: 'mcp_tool_calls_total',
      help: 'MCP tool calls by server, tool and result (ok or error code).',
      labelNames: ['server', 'tool', 'result'],
      registers: [registry],
    }),
    latency: new Histogram({
      name: 'mcp_tool_latency_ms',
      help: 'MCP tool call latency in milliseconds.',
      labelNames: ['server', 'tool'],
      buckets: LATENCY_BUCKETS_MS,
      registers: [registry],
    }),
    truncated: new Counter({
      name: 'mcp_tool_output_truncated_total',
      help: 'MCP tool outputs replaced by an evidence pointer.',
      labelNames: ['server', 'tool'],
      registers: [registry],
    }),
  };
}
