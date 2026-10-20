/** DI token of the frozen, validated `ApiConfig`. */
export const API_CONFIG = Symbol.for('blackwing.api.config');

/** DI token of the root `@blackwing/logger` logger of the process. */
export const API_LOGGER = Symbol.for('blackwing.api.logger');

/** DI token of the `HttpMetrics` of the app instance (counters/histograms on a private registry). */
export const API_METRICS = Symbol.for('blackwing.api.metrics');

/** DI token of the `HealthProbe[]` the health endpoints check (API-011). */
export const API_HEALTH_PROBES = Symbol.for('blackwing.api.health.probes');

/** DI token of the health gauges. */
export const API_HEALTH_METRICS = Symbol.for('blackwing.api.health.metrics');
/** DI token of the optional {@link SecurityEventSink}; AUDIT wires `emitAudit` behind it. */
export const API_SECURITY_EVENT_SINK = Symbol.for('blackwing.api.security-event-sink');

/** DI token of the `ProblemRegistry` the exception filter resolves codes against. */
export const API_PROBLEM_REGISTRY = Symbol.for('blackwing.api.problem-registry');
