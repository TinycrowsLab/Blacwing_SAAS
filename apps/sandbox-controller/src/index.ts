/** Workspace package name of this app. */
export const name = '@blackwing/sandbox-controller';

/**
 * Package version; kept in sync with package.json and `./version.ts` (check-layout needs the literal here,
 * `./version.ts` exists so internal modules need not import this barrel).
 */
export const version = '0.0.0';

export {
  type AuditEmitter,
  type ControllerAuditEvent,
  type ControllerAuditType,
  createLogAuditEmitter,
} from './audit.js';
export {
  CLOCK_SKEW_SECONDS,
  createHmacRunTokenVerifier,
  type HmacRunTokenOptions,
  isProtectedPath,
  MAX_RUN_TOKEN_LENGTH,
  PROTECTED_PREFIX,
  registerRunTokenAuth,
  RUN_TOKEN_PREFIX,
  type RunContext,
  type RunTokenClaims,
  type RunTokenVerifier,
  SANDBOX_CONTROLLER_AUDIENCE,
  signRunToken,
} from './auth.js';
export {
  configHash,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MGMT_ADDR,
  DEFAULT_TTL_SECONDS,
  type ListenAddress,
  loadSandboxControllerConfig,
  MIN_RUN_TOKEN_SECRET_LENGTH,
  SANDBOX_DRIVERS,
  type SandboxControllerConfig,
  sandboxControllerEnvSchema,
  sandboxControllerEnvShape,
  type SandboxDriverKind,
} from './config.js';
export {
  type ControllerDeps,
  flushGlobalTelemetry,
  type RunningController,
  type ShutdownResult,
  startSandboxController,
  type TelemetryFlusher,
} from './controller.js';
export {
  type CaProvisioner,
  createDriver,
  type DriverFactory,
  FakeDriver,
  type FakeDriverOptions,
  type RunCaRef,
  type RunScope,
  type SandboxDriver,
  UnavailableDriver,
} from './drivers/index.js';
export {
  type AuthFailureReason,
  SBX_ERROR_CODES,
  SbxBadRequestError,
  SbxConfigInvalidError,
  SbxDriverUnavailableError,
  type SbxErrorCode,
  SbxUnauthenticatedError,
} from './errors.js';
export { type ControllerMetrics, createControllerMetrics } from './metrics.js';
export {
  createReadinessMonitor,
  type DependencyProbe,
  type ReadinessMonitor,
  type ReadinessOptions,
} from './readiness.js';
export { buildServer, requestLogger, type ServerOptions } from './server.js';
export { createValkeyProbe, type ValkeyProbe } from './valkey.js';
