/** Workspace package name of this package. */
export const name = '@blackwing/logger';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  configureLogging,
  createLogger,
  type CreateLoggerOptions,
  type LogContext,
  type Logger,
  type LoggerSettings,
  type TenantLogContext,
  type TenantLogger,
  withContext,
} from './logger.js';
export {
  BUILTIN_SECRET_PATTERNS,
  isSensitiveKey,
  REDACT_PATHS,
  REDACTED,
  redactText,
  registerSecretPattern,
  secretPatternNames,
} from './redaction.js';
export {
  CIRCULAR,
  DEFAULT_MAX_COLLECTION_ITEMS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FIELD_BYTES,
  MAX_DEPTH,
  TRUNCATED,
  UNSERIALIZABLE,
} from './sanitize.js';
export { activeTraceFields, type TraceFields } from './trace.js';
