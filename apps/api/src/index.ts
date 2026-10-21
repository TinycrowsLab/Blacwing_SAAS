/** Workspace package name of this app. */
export const name = '@blackwing/api';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { AppModule, type AppModuleOptions, ConfigModule, LoggerModule } from './app.module.js';
export {
  API_PREFIX,
  type ApiApp,
  createApiApp,
  type CreateApiAppOptions,
  GLOBAL_PREFIX_EXCLUDES,
} from './bootstrap/create-app.js';
export { createHttpMetrics, type HttpMetrics, UNMATCHED_ROUTE } from './bootstrap/metrics.js';
export {
  bindTenant,
  currentRoute,
  currentTraceId,
  requestLogger,
  TRACER_NAME,
} from './bootstrap/request-context.js';
export { SHUTDOWN_SIGNALS } from './bootstrap/shutdown.js';
export {
  API_CONFIG,
  API_LOGGER,
  API_METRICS,
  API_PROBLEM_REGISTRY,
  API_SECURITY_EVENT_SINK,
} from './bootstrap/tokens.js';
export * from './errors/index.js';
export { deriveTraceId, traceIdFromTraceparent } from './bootstrap/trace-id.js';
export {
  type ApiConfig,
  apiEnvSchema,
  apiEnvShape,
  DEFAULT_API_BODY_LIMIT_BYTES,
  DEFAULT_API_HOST,
  DEFAULT_API_MAX_JSON_DEPTH,
  DEFAULT_API_PORT,
  DEFAULT_API_SHUTDOWN_GRACE_MS,
  loadApiConfig,
} from './config.js';
export { BOOT_FAILURE_EXIT_CODE, runApi, type RunApiOptions } from './run.js';
export * from './validation/index.js';
export * from './kill/index.js';
export * from './concurrency/index.js';
export * from './pagination/index.js';
