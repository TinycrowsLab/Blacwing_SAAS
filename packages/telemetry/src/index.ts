/** Workspace package name of this package. */
export const name = '@blackwing/telemetry';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { safeAttr } from './attributes.js';
export {
  type OtelSampler,
  OTEL_SAMPLERS,
  readTelemetryConfig,
  samplerRatio,
  type TelemetryConfig,
  telemetryConfigSchema,
} from './config.js';
export {
  getMeter,
  getTracer,
  type InitTelemetryOptions,
  initTelemetry,
  SHUTDOWN_TIMEOUT_MS,
  shutdownTelemetry,
  type TelemetryExporters,
  withSpan,
} from './otel.js';
export {
  createWorkflowContext,
  findWorkflowContext,
  getActivityContext,
  runWithWorkflowContext,
  type WorkflowContextInit,
} from './context.js';
