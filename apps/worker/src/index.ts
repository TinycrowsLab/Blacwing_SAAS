/** Workspace package name of this app. */
export const name = '@blackwing/worker';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { ALL_TASK_QUEUES, TASK_QUEUES, type TaskQueueName } from './task-queues.js';
export {
  createKillActivities,
  egressIdentityKey,
  type KillActivityDeps,
} from './kill/activities.js';
export { createHttpEgressControlClient, EGRESS_KILL_PATH } from './kill/egress-client.js';
export { createHttpKeyControlClient, KEYS_REVOKE_PATH } from './kill/key-client.js';
export {
  createHttpSandboxControlClient,
  SANDBOX_TERMINATE_PATH,
  sandboxDeadlineFromEnv,
} from './kill/sandbox-client.js';
export {
  createAuditActivities,
  createAuditActivityInterceptors,
  createOtelAuditMetrics,
  isCriticalActivity,
  type AuditInterceptorDeps,
  type AuditInterceptorMetrics,
} from './interceptors/audit.js';
export { createTenantActivityInterceptors, type TenantActivityDeps } from './tenant/interceptor.js';
export {
  createTemporalWorkflowControlClient,
  type WorkflowHandleSource,
} from './kill/workflow-client.js';
export { createOtelKillMetrics } from './kill/metrics.js';
export {
  planSearchAttributeRegistration,
  registerSearchAttributes,
  type RegisterSearchAttributesOptions,
  type SearchAttributeOperator,
  type SearchAttributeRegistrationOutcome,
  type SearchAttributeRegistrationResult,
} from './search-attribute-registration.js';
export {
  RUN_STATE_VALUES,
  runStartSearchAttributes,
  runStateSearchAttributes,
  SEARCH_ATTRIBUTES,
  type RunSearchAttributeInput,
  type SearchAttributeName,
  type SearchAttributeType,
  upsertRunSearchAttributes,
} from './search-attributes.js';
export type * from './kill/ports.js';
export * from './kill/types.js';
export {
  createPreflightActivities,
  type PreflightActivityDeps,
} from './run/preflight/activities.js';
export { isDisallowedAddress } from './run/preflight/address-guard.js';
export { decide as decidePreflight, executePreflight } from './run/preflight/aggregate.js';
export { createOtelPreflightMetrics } from './run/preflight/metrics.js';
export type * from './run/preflight/ports.js';
export * from './run/preflight/types.js';
export {
  createSaBoundsActivities,
  MAX_TIMER_MS,
  type SaBoundsActivityDeps,
} from './sa-bounds/activities.js';
export { createOtelSaBoundsMetrics } from './sa-bounds/metrics.js';
export { computeSaTimeline } from './sa-bounds/timeline.js';
export type * from './sa-bounds/ports.js';
export * from './sa-bounds/types.js';
export {
  createVerificationDnsActivities,
  type VerificationDnsActivities,
  type VerificationDnsActivityDeps,
  type VerifyDnsTxtInput,
  type VerifyDnsTxtResult,
} from './verification/dns-txt/activities.js';
export { createPgVerificationDnsStore } from './verification/dns-txt/store-pg.js';
export { createOtelVerificationDnsMetrics } from './verification/dns-txt/metrics.js';
export { createPinnedDnsResolver, type DnsResolver } from './verification/dns-txt/resolver.js';
export {
  DnsResolverUnavailableError,
  observeDnsTxt,
  type DnsTxtObservation,
} from './verification/dns-txt/observe.js';
export {
  createPostExecutionActivities,
  type PostExecutionActivityDeps,
} from './run/postexec/activities.js';
export { acceptedRiskValid, classifyVerdict, dedupeDecisions } from './run/postexec/classify.js';
export { createOtelPostExecutionMetrics } from './run/postexec/metrics.js';
export type * from './run/postexec/ports.js';
export * from './run/postexec/types.js';
export {
  createAgentSessionActivities,
  type AgentSessionActivityDeps,
} from './agent-session/activities.js';
export { costEntries, UNATTRIBUTED_MODEL } from './agent-session/cost.js';
export { createOtelSessionMetrics } from './agent-session/metrics.js';
export { runAgentSessionLifecycle, SandboxProvisionError } from './agent-session/lifecycle.js';
export type * from './agent-session/ports.js';
export * from './agent-session/types.js';
export { createReconActivities, type ReconActivityDeps } from './run/recon/activities.js';
export { createOtelReconMetrics } from './run/recon/metrics.js';
export {
  allFailed as allReconSessionsFailed,
  runSessions as runReconSessions,
} from './run/recon/orchestrate.js';
export type * from './run/recon/ports.js';
export * from './run/recon/types.js';
export {
  createExecutionActivities,
  type ExecutionActivityDeps,
} from './run/execution/activities.js';
export { temporalActivityRuntime } from './run/execution/activity-context.js';
export {
  classifyOutOfEnvelope,
  isExhausted,
  nextIntervention,
  sanitiseSummary,
} from './run/execution/frontier.js';
export { createOtelExecutionMetrics } from './run/execution/metrics.js';
export { createGate2Store } from './run/execution/gate2-store.js';
export {
  createGate2ExceptionActivities,
  type Gate2ExceptionActivityDeps,
} from './run/execution/gate2-exception.js';
export { createPgGate2ExceptionStore } from './run/execution/gate2-exception-store.js';
export type * from './run/execution/ports.js';
export * from './run/execution/types.js';
export {
  createDispatchActivities,
  egressIdentityFor,
  renderBrief,
  type DispatchActivityDeps,
} from './run/dispatch/activities.js';
export { assertPersonaEligible, DispatchRejection } from './run/dispatch/eligibility.js';
export { createOtelDispatchMetrics } from './run/dispatch/metrics.js';
export type * from './run/dispatch/ports.js';
export * from './run/dispatch/types.js';
export { createPlanningActivities, type PlanningActivityDeps } from './run/planning/activities.js';
export { evaluateAutoApproval } from './run/planning/auto-approval.js';
export { createOtelPlanningMetrics } from './run/planning/metrics.js';
export { checkPlan } from './run/planning/plan-check.js';
export type * from './run/planning/ports.js';
export * from './run/planning/types.js';
