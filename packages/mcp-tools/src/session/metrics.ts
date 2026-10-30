import { Counter, type Registry } from 'prom-client';

/** Role-switching metrics (AUTHLOGIC persona observability, #696); register once per registry. */
export interface SessionMetrics {
  /** `authz_role_switches_total{outcome}`: `use_role` answers by the role session's status. */
  readonly roleSwitches: Counter<'outcome'>;
  /** `mcp_session_checks_total{outcome}`: `check_session` answers by the role session's status. */
  readonly sessionChecks: Counter<'outcome'>;
}

export function createSessionMetrics(registry: Registry): SessionMetrics {
  return {
    roleSwitches: new Counter({
      name: 'authz_role_switches_total',
      help: 'Role switches requested through use_role, by the resulting role session status.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    sessionChecks: new Counter({
      name: 'mcp_session_checks_total',
      help: 'Role session checks made through check_session, by status.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
  };
}
