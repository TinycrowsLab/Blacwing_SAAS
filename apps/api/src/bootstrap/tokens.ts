/** DI token of the frozen, validated `ApiConfig`. */
export const API_CONFIG = Symbol.for('blackwing.api.config');

/** DI token of the root `@blackwing/logger` logger of the process. */
export const API_LOGGER = Symbol.for('blackwing.api.logger');

/** DI token of the `HttpMetrics` of the app instance (counters/histograms on a private registry). */
export const API_METRICS = Symbol.for('blackwing.api.metrics');
