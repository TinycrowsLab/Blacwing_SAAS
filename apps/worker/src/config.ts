import { z } from 'zod';

import { baseEnvSchema, loadConfig, zDurationMs, zPort, type EnvSource } from '@blackwing/config';

import { parseTaskQueues, type TaskQueueName } from './task-queues.js';

const DEFAULT_MAX_ACTIVITY_CONCURRENCY = 20;
const DEFAULT_MAX_WORKFLOW_CONCURRENCY = 40;
const DEFAULT_HEALTH_PORT = 13800;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

/** Positive integer from a string env value. Zero, signs, fractions and blanks are rejected. */
const positiveInt = z
  .string()
  .regex(/^[1-9][0-9]{0,5}$/, 'must be a positive integer')
  .transform(Number);

const workerEnvSchema = baseEnvSchema.extend({
  TEMPORAL_MAX_ACTIVITY_CONCURRENCY: positiveInt.default(DEFAULT_MAX_ACTIVITY_CONCURRENCY),
  TEMPORAL_MAX_WORKFLOW_CONCURRENCY: positiveInt.default(DEFAULT_MAX_WORKFLOW_CONCURRENCY),
  WORKER_TASK_QUEUES: z.string().optional(),
  WORKER_HEALTH_PORT: zPort().default(DEFAULT_HEALTH_PORT),
  WORKER_SHUTDOWN_GRACE: zDurationMs().default(DEFAULT_SHUTDOWN_GRACE_MS),
});

/** Validated worker process settings. */
export interface WorkerConfig {
  readonly maxConcurrentActivityTaskExecutions: number;
  readonly maxConcurrentWorkflowTaskExecutions: number;
  readonly taskQueues: readonly TaskQueueName[];
  readonly healthPort: number;
  /** How long `worker.shutdown()` lets in-flight tasks drain before the SDK forces them. */
  readonly shutdownGraceMs: number;
}

/** Parses the worker environment. Throws on invalid values and `WORKER_QUEUE_UNKNOWN` on a bad queue. */
export function parseWorkerConfig(source: EnvSource = process.env): WorkerConfig {
  const env = loadConfig(workerEnvSchema, source);
  return {
    maxConcurrentActivityTaskExecutions: env.TEMPORAL_MAX_ACTIVITY_CONCURRENCY,
    maxConcurrentWorkflowTaskExecutions: env.TEMPORAL_MAX_WORKFLOW_CONCURRENCY,
    taskQueues: parseTaskQueues(env.WORKER_TASK_QUEUES),
    healthPort: env.WORKER_HEALTH_PORT,
    shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE,
  };
}
