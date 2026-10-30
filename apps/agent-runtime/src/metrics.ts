import { Counter, Registry } from 'prom-client';

/** Agent runtime metrics (RUNTIME-001, #463). One registry per process; the host scrapes or forwards it. */
export interface RuntimeMetrics {
  readonly registry: Registry;
  /** `agent_runtime_sessions_started_total{persona}`: counted once per session that reaches the model path. */
  readonly sessionsStarted: Counter<'persona'>;
  /** `agent_runtime_options_built_total{persona}`: counted once per session whose SDK options were built (RUNTIME-002). */
  readonly optionsBuilt: Counter<'persona'>;
  /**
   * `agent_tool_denied_total{persona,tool,reason}`: one per denied tool call the SDK reported (RUNTIME-003). `tool` is the
   * exact name only when the descriptor declares it, and `other` otherwise, so model-chosen names cannot grow the series.
   */
  readonly toolDenied: Counter<'persona' | 'tool' | 'reason'>;
}

export function createRuntimeMetrics(registry: Registry = new Registry()): RuntimeMetrics {
  return {
    registry,
    sessionsStarted: new Counter({
      name: 'agent_runtime_sessions_started_total',
      help: 'Agent sessions started by the runtime, by persona.',
      labelNames: ['persona'],
      registers: [registry],
    }),
    optionsBuilt: new Counter({
      name: 'agent_runtime_options_built_total',
      help: 'Agent session SDK options built by the runtime, by persona.',
      labelNames: ['persona'],
      registers: [registry],
    }),
    toolDenied: new Counter({
      name: 'agent_tool_denied_total',
      help: 'Agent tool calls denied by the tool gate, by persona, tool and reason.',
      labelNames: ['persona', 'tool', 'reason'],
      registers: [registry],
    }),
  };
}
