import { AppError } from '@blackwing/errors';

/** Every Temporal task queue Blackwing workers poll (WORKFLOW-002). Import these; never write the strings. */
export const TASK_QUEUES = Object.freeze({
  RUN_ORCHESTRATION: 'run-orchestration',
  AGENT_SESSIONS: 'agent-sessions',
  VALIDATION: 'validation',
  EXPORTS: 'exports',
  CONNECTORS: 'connectors',
  NOTIFICATIONS: 'notifications',
  RETENTION: 'retention',
  SCHEDULER: 'scheduler',
  OUTBOX_RELAY: 'outbox-relay',
} as const);

/** A task-queue name, e.g. `'run-orchestration'`. */
export type TaskQueueName = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

/** All task-queue names, in declaration order. */
export const ALL_TASK_QUEUES: readonly TaskQueueName[] = Object.freeze(Object.values(TASK_QUEUES));

function isTaskQueueName(value: string): value is TaskQueueName {
  return (ALL_TASK_QUEUES as readonly string[]).includes(value);
}

/**
 * Resolves `WORKER_TASK_QUEUES` (comma list). Unset or blank means every queue. Duplicates collapse.
 * An unknown name fails fast with `WORKER_QUEUE_UNKNOWN`: a typo must not silently leave a queue unserved.
 */
export function parseTaskQueues(raw: string | undefined): readonly TaskQueueName[] {
  if (raw === undefined || raw.trim() === '') return ALL_TASK_QUEUES;
  const selected = new Set<TaskQueueName>();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!isTaskQueueName(name)) {
      throw new AppError(
        'WORKER_QUEUE_UNKNOWN',
        `Unknown task queue "${name}" in WORKER_TASK_QUEUES (known: ${ALL_TASK_QUEUES.join(', ')})`,
      );
    }
    selected.add(name);
  }
  return [...selected];
}
