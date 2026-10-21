/** Workspace package name of this app. */
export const name = '@blackwing/worker';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { ALL_TASK_QUEUES, TASK_QUEUES, type TaskQueueName } from './task-queues.js';
export { createKillActivities, egressIdentityKey, type KillActivityDeps } from './kill/activities.js';
export { createHttpEgressControlClient, EGRESS_KILL_PATH } from './kill/egress-client.js';
export { createOtelKillMetrics } from './kill/metrics.js';
export type * from './kill/ports.js';
export * from './kill/types.js';
