import { Counter, Registry } from 'prom-client';

/** Agent runtime metrics (RUNTIME-001, #463). One registry per process; the host scrapes or forwards it. */
export interface RuntimeMetrics {
  readonly registry: Registry;
  /** `agent_runtime_sessions_started_total{persona}`: counted once per session that reaches the model path. */
  readonly sessionsStarted: Counter<'persona'>;
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
  };
}
