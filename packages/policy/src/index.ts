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
