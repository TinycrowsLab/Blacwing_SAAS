/** Workspace package name of this package. */
export const name = '@blackwing/queue';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  type BullConfig,
  DEFAULT_BULL_PREFIX,
  DEFAULT_REDIS_URL,
  DEFAULT_WORKER_CONCURRENCY,
  parseBullConfig,
} from './config.js';
export {
  type BullJobContext,
  type BullProcessor,
  type BullProducerOptions,
  type BullQueue,
  type BullQueueOptions,
  type BullWorker,
  type BullWorkerOptions,
  createQueue,
  createWorker,
  DEFAULT_BACKOFF_DELAY_MS,
  DEFAULT_ENQUEUE_TIMEOUT_MS,
  DEFAULT_JOB_ATTEMPTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  defaultJobOptions,
  getBullConnection,
} from './bull.js';
export { createOtelQueueMetrics, type QueueGaugeSample, type QueueMetrics } from './metrics.js';
