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
  createPostExecutionActivities,
  type PostExecutionActivityDeps,
} from './run/postexec/activities.js';
export { acceptedRiskValid, classifyVerdict, dedupeDecisions } from './run/postexec/classify.js';
export { createOtelPostExecutionMetrics } from './run/postexec/metrics.js';
export type * from './run/postexec/ports.js';
export * from './run/postexec/types.js';
