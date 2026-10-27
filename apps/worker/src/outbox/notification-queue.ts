import { Queue, type ConnectionOptions } from 'bullmq';

import type { NotificationQueue } from './ports.js';

/** BullMQ queue the NOTIFY workers consume. */
export const NOTIFICATIONS_QUEUE = 'notifications';

const RETAIN_COMPLETED_SECONDS = 86_400; // one day
const RETAIN_FAILED_SECONDS = 604_800; // seven days

/**
 * The `notifications` queue on Valkey. Completed jobs are retained for a day so a late redelivery of
 * the same `jobId` is still dropped. `close()` ends the connection (graceful shutdown).
 */
export function createBullmqNotificationQueue(
  connection: ConnectionOptions,
): NotificationQueue & { close(): Promise<void> } {
  const queue = new Queue(NOTIFICATIONS_QUEUE, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { age: RETAIN_COMPLETED_SECONDS },
      removeOnFail: { age: RETAIN_FAILED_SECONDS },
    },
  });
  return {
    async add(job) {
      await queue.add(
        'notify.send',
        { tenantId: job.tenantId, payload: job.data },
        { jobId: job.jobId },
      );
    },
    close: () => queue.close(),
  };
}
