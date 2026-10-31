/** Workspace package name of this package. */
export const name = '@blackwing/config';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  type StringOptions,
  type UrlOptions,
  zBool,
  zCsv,
  zDurationMs,
  zPort,
  zSecret,
  zSecretUrl,
  zString,
  zUrl,
} from './coerce.js';
export {
  CONFIG_EXIT_CODE,
  type DefineConfigOptions,
  defineConfig,
  type EnvSource,
  type InvalidConfigAction,
  type LoadConfigOptions,
  loadConfig,
} from './env.js';
export {
  type ConfigIssue,
  type ConfigIssueReason,
  ConfigValidationError,
  isConfigValidationError,
} from './errors.js';
export {
  type ConfigLoadedEvent,
  type ConfigLoadedFields,
  type ConfigLogSink,
  drainConfigLoadEvents,
  MAX_BUFFERED_CONFIG_EVENTS,
} from './events.js';
export { safeMessage } from './issues.js';
export {
  isMarkedSecret,
  markSecret,
  type RedactionRegistry,
  redactionRegistry,
  type Secret,
  unmarkSecret,
} from './redaction.js';
export {
  type BaseEnv,
  baseEnvSchema,
  baseEnvShape,
  type DatabaseEnv,
  databaseEnvSchema,
  databaseEnvShape,
  type EvidenceStoreEnv,
  evidenceStoreEnvSchema,
  evidenceStoreEnvShape,
  LOG_LEVELS,
  type LogLevel,
  NODE_ENVS,
  type NodeEnv,
  type OobEnv,
  oobEnvSchema,
  oobEnvShape,
  type ValkeyEnv,
  valkeyEnvSchema,
  valkeyEnvShape,
} from './schema.js';
export {
  type StallEnv,
  stallConfigFromEnv,
  stallEnvSchema,
  stallEnvShape,
  type StallThresholds,
  type StallThresholdsOverride,
  stallThresholdsOverrideSchema,
  stallThresholdsSchema,
} from './stall.js';
export {
  DEFAULT_TEMPORAL_ADDRESS,
  DEFAULT_TEMPORAL_NAMESPACE,
  parseTemporalConfig,
  type TemporalConfig,
  type TemporalEnv,
  temporalConfigSchema,
  temporalEnvShape,
} from './temporal.js';
