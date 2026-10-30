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
export {
  compileRuleBuilder,
  PolicyBuilderError,
  type CompiledRuleBuilder,
  type RuleBuilderIssue,
  type RuleBuilderWarning,
} from './rule-builder/compile.js';
export {
  builderRuleSchema,
  type BuilderRule,
  type Condition,
  RULE_BUILDER_LIMITS,
  type RuleBuilderPolicy,
  ruleBuilderPolicySchema,
} from './rule-builder/json.js';
export {
  CURRENT_PRICE_TABLE_VERSION,
  PRICE_TABLE_2026_10_01,
  PRICE_TABLE_2026_10_21,
  PriceTableError,
  computeCost,
  currentVersion,
  getPriceTable,
  priceTableDigest,
  priceTablePin,
  priceTableSha256,
  resolvePinnedTable,
  staticPriceTableResolver,
  type CostOptions,
  type CostResult,
  type ModelPrice,
  type PriceFailureReason,
  type PriceTable,
  type PriceTablePin,
  type PriceTableResolver,
  type TokenUsage,
} from './price-table.js';
export {
  AUTHZ_ACTIONS,
  type AuthzAction,
  type AuthzPrincipal,
  type AuthzResource,
  type ServiceAccountPrincipal,
  type UserPrincipal,
} from './authz/entities.js';
export {
  AuthzPolicyLoadError,
  authzEngine,
  can,
  createAuthzEngine,
  loadAuthzSources,
  type AuthzDecision,
  type AuthzEngine,
  type AuthzSources,
} from './authz/engine.js';
export { checkResource, type AuthzDecisionLog } from './authz/check.js';
export {
  assembleEffectivePolicySet,
  canonicalPolicySource,
  policySourceSha256,
  type EffectivePolicySet,
  type PolicySetLayer,
  type TenantPolicyVersionRef,
} from './tenant-policy.js';
