import { Counter, Registry } from 'prom-client';

/** Agent runtime metrics (RUNTIME-001, #463). One registry per process; the host scrapes or forwards it. */
export interface RuntimeMetrics {
  readonly registry: Registry;
  /** `agent_runtime_sessions_started_total{persona}`: counted once per session that reaches the model path. */
  readonly sessionsStarted: Counter<'persona'>;
  /** `agent_runtime_options_built_total{persona}`: counted once per session whose SDK options were built (RUNTIME-002). */
  readonly optionsBuilt: Counter<'persona'>;
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
  };
}
