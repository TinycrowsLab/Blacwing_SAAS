/** Workspace package name of this app. */
export const name = '@blackwing/session-manager';

/**
 * Package version; kept in sync with package.json and `./version.ts` (check-layout needs the literal here,
 * `./version.ts` exists so internal modules need not import this barrel).
 */
export const version = '0.0.0';

export {
  type AuditEmitter,
  createLogAuditEmitter,
  type SessionManagerAuditEvent,
  type SessionManagerAuditType,
} from './audit.js';
export { assertScope, isProtectedPath, PROTECTED_PREFIX, type RouteScope } from './auth.js';
export {
  configHash,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MGMT_ADDR,
  DEFAULT_OPENBAO_ADDR,
  DEFAULT_SESSION_TTL_SECONDS,
  type ListenAddress,
  loadSessionManagerConfig,
  MIN_TOKEN_SECRET_LENGTH,
  type SessionManagerConfig,
  sessionManagerEnvSchema,
  sessionManagerEnvShape,
} from './config.js';
export {
  type RunningSessionManager,
  type SessionManagerDeps,
  type ShutdownResult,
  startSessionManager,
} from './controller.js';
export {
  type AuthFailureReason,
  SM_ERROR_CODES,
  type SmErrorCode,
  SmBadRequestError,
  SmConfigInvalidError,
  SmLockedOutError,
  SmLoginFailedError,
  SmRecipeInvalidError,
  SmSessionExpiredError,
  SmTenantMismatchError,
  SmUnauthenticatedError,
} from './errors.js';
export { type SessionManagerMetrics, createSessionManagerMetrics } from './metrics.js';
export { internalSessionRoutes } from './routes.js';
export { redactLogValue } from './redaction.js';
export { createOpenBaoProbe, createPostgresProbe, createValkeyProbe } from './probes.js';
export {
  createReadinessMonitor,
  type DependencyProbe,
  type ReadinessMonitor,
  type ReadinessOptions,
} from './readiness.js';
export { buildServer, requestLogger, type ServerOptions } from './server.js';
export {
  CLOCK_SKEW_SECONDS,
  CONTROL_TOKEN_PREFIX,
  createTokenVerifier,
  type Principal,
  RUN_TOKEN_PREFIX,
  SESSION_MANAGER_AUDIENCE,
  signControlToken,
  signRunToken,
  type TokenClaims,
  type TokenVerifier,
} from './tokens.js';
