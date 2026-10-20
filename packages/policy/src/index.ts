/** Workspace package name of this package. */
export const name = '@blackwing/policy';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  BLACKWING_SCHEMA_PATH,
  SCHEMA_SHA256,
  SCHEMA_VERSION,
  cedarDatetime,
  intrusivenessValue,
  loadBlackwingSchema,
  schemaDigest,
  schemaPin,
  toCedarAttrs,
  validatePolicies,
  validateSchema,
  type SchemaPin,
  type ValidationResult,
} from './schema.js';
export * from './schema.types.js';
export {
  BASELINE_DIR,
  BASELINE_ID_PREFIX,
  BASELINE_SHA256,
  BASELINE_VERSION,
  BaselineIntegrityError,
  loadBaseline,
  baselineDigest,
  baselinePin,
  compilePolicySet,
  isBaselinePolicyId,
  loadBaselinePolicies,
  type Baseline,
  type BaselineFile,
  type BaselinePin,
  type BaselinePolicy,
  type CompiledPolicySet,
  type RejectedPolicySet,
} from './baseline.js';
