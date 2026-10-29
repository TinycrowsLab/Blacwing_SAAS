/** Workspace package name of this package. */
export const name = '@blackwing/replay';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { httpFetcher } from './fetcher.js';
export { assertLabTarget, LAB_HOSTS, type LabTarget } from './lab-guard.js';
export {
  bodyDigest,
  evaluateErrorSignature,
  type ErrorSignatureOracle,
  type ObservedResponse,
  type OracleVerdict,
} from './oracle.js';
export {
  buildJuiceShopSqliPlan,
  JUICE_SHOP_LAB_IMAGE,
  JUICE_SHOP_LAB_ORIGIN,
  JUICE_SHOP_SQLI_CONTROL,
  JUICE_SHOP_SQLI_ORACLE,
  JUICE_SHOP_SQLI_ORACLE_ID,
  JUICE_SHOP_SQLI_PROBE,
  JUICE_SHOP_SQLI_TEST_CASE_ID,
  juiceShopScopeRules,
} from './juice-shop-sqli.js';
export {
  type Fetcher,
  type ObservedExchange,
  replayFinding,
  type ReplayOutcome,
  type ReplayPlan,
  type ReplayResult,
  type SuspectReason,
} from './replay.js';
