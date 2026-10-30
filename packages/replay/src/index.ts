/** Workspace package name of this package. */
export const name = '@blackwing/replay';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { httpFetcher } from './fetcher.js';
export { assertLabTarget, LAB_HOSTS, type LabTarget } from './lab-guard.js';
export { createDeterministicEvaluators, OracleBaselineMissingError } from './oracles/index.js';
export {
  bodyDigest,
  evaluateErrorSignature,
  type ErrorSignatureOracle,
  type ObservedHeader,
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
export { createLabEgress, createLocalSandboxProvider, LAB_PROBE_TIMEOUT_MS } from './adapters.js';
export {
  ACCESS_MATRIX_AUDIT_EVENT,
  ACCESS_MATRIX_REASONS,
  accessMatrixEvaluator,
  assertBenignSentinel,
  createSignalEvaluators,
  FILE_READ_REASONS,
  fileReadEvaluator,
  noopOracleMetrics,
  OOB_AUDIT_EVENT,
  OOB_REASONS,
  oobEvaluator,
  type OobSignal,
  type OracleMetrics,
  type ReplaySignals,
  type RoleAccess,
  type SignalStore,
  TIMING_REASONS,
  timingBaselineEvaluator,
  type TimingSignal,
} from './oracles/index.js';
export {
  createOracleDispatcher,
  type DispatchOutcome,
  type OracleDispatcher,
  type OracleEvaluator,
  UnknownOracleError,
} from './dispatch.js';
export {
  createExpiryGate,
  type AuthorisationGate,
  type Egress,
  type EvidenceCapture,
  type EvidenceReader,
  isStateChanging,
  MAX_EXCHANGE_BODY_BYTES,
  MAX_PROVISION_ATTEMPTS,
  type RawObservation,
  type RawObservation as ReplayObservation,
  ReplayEngine,
  type ReplayEngineDeps,
  type ReplayExchange,
  type ReplayAudit,
  type ReplayAuditEvent,
  type ReplayStatus as ReplayRunStatus,
  type ReversalJournal,
  type RunOptions,
  type Sandbox,
  type SandboxProvider,
  type StepHandler,
  type StepHandlers,
} from './engine.js';
export { noopReplayMetrics, REPLAY_TRACER, type ReplayMetrics } from './telemetry.js';
export {
  type Fetcher,
  type ObservedExchange,
  replayFinding,
  type ReplayOutcome,
  type ReplayPlan,
  type ReplayResult,
  type SuspectReason,
} from './replay.js';
