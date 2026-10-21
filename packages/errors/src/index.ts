/** Workspace package name of this package. */
export const name = '@blackwing/errors';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  AppError,
  type AppErrorJson,
  type AppErrorOptions,
  AuthError,
  ConflictError,
  ForbiddenError,
  IllegalRunTransitionError,
  InternalError,
  isAppError,
  type KillScope,
  KillSwitchActiveError,
  type KillSwitchActiveErrorOptions,
  NotFoundError,
  PreconditionFailedError,
  PreconditionRequiredError,
  RateLimitedError,
  type RateLimitedErrorOptions,
  ScopeViolationError,
  TenantContextMissingError,
  type TenantContextMissingErrorOptions,
  type TenantContextMissingReason,
  ValidationError,
} from './app-error.js';
export {
  ERROR_CODE_LIST,
  ERROR_CODES,
  type ErrorCode,
  type ErrorCodeSpec,
  httpStatusFor,
  type HttpStatusOf,
  isErrorCode,
  PROBLEM_TYPE_BASE,
  problemTypeFor,
} from './codes.js';
export {
  createProblemDetailsMapper,
  DEFAULT_MAX_DETAIL_LENGTH,
  type ErrorEnvironment,
  type ErrorLogEntry,
  type ErrorLogSink,
  PROBLEM_JSON_CONTENT_TYPE,
  type ProblemDetails,
  type ProblemDetailsMapper,
  type ProblemDetailsOptions,
  type ProblemResponse,
  type ProblemResponseHeaders,
  toProblemDetails,
  toProblemResponse,
  UNKNOWN_TRACE_ID,
} from './problem.js';
export { containsStackTrace, REDACTED, redactBuiltinSecrets, type Redactor } from './redaction.js';
export { MAX_CAUSE_DEPTH, type SerializedError, serializeErrorForLog } from './serialize.js';
