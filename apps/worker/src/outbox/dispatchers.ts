import { createHash } from 'node:crypto';

import { z } from 'zod';

import { appendAuditOutboxPayload } from '@blackwing/audit';
import { type Database, withTenant } from '@blackwing/db';
import { ValidationError } from '@blackwing/errors';

import { toAuditSqlTx } from './audit-tx.js';

import type { NotificationQueue, OutboxDispatcher, WorkflowSignalSource } from './ports.js';
import type { OutboxMessageType } from '@blackwing/contracts';

const NAME_MAX = 255;

/** Payload of a `temporal.signal` row. `input` reaches the workflow inside the envelope below. */
const signalPayloadSchema = z.strictObject({
  workflowId: z.string().min(1).max(NAME_MAX),
  runId: z.string().min(1).max(NAME_MAX).optional(),
  signal: z.string().min(1).max(NAME_MAX),
  input: z.json().optional(),
});

/**
 * The single argument every relayed signal carries. Delivery is at least once and Temporal does not
 * dedupe signals, so the receiving workflow drops a `dedupeKey` it has already handled.
 */
export interface RelayedSignal {
  readonly dedupeKey: string;
  readonly input?: unknown;
}

export interface OutboxDispatcherDeps {
  /** The app-role database: audit rows are appended under `withTenant`, never on the relay role. */
  readonly appDb: Database;
  readonly notifications: NotificationQueue;
  readonly workflows: WorkflowSignalSource;
}

/**
 * Job id of a notification: stable across redeliveries and namespaced by tenant, so BullMQ drops the
 * repeat. Hashed because BullMQ rejects custom ids containing `:`.
 */
export function notificationJobId(
  tenantId: string,
  rowId: string,
  dedupeKey: string | null,
): string {
  return createHash('sha256')
    .update(`${tenantId}\0${dedupeKey ?? rowId}`)
    .digest('hex');
}

/** One dispatcher per outbox message type (WORKFLOW-012). Each runs under the row's own tenant. */
export function createOutboxDispatchers(
  deps: OutboxDispatcherDeps,
): Record<OutboxMessageType, OutboxDispatcher> {
  return {
    // The chain append is idempotent on the event id, so a redelivered row is a no-op.
    'audit.event': async (row) => {
      await withTenant(deps.appDb, row.tenantId, async (tx) => {
        await appendAuditOutboxPayload(toAuditSqlTx(tx), row.payload);
      });
    },
    'notify.send': async (row) => {
      await deps.notifications.add({
        jobId: notificationJobId(row.tenantId, row.id, row.dedupeKey),
        tenantId: row.tenantId,
        data: row.payload,
      });
    },
    'temporal.signal': async (row) => {
      const parsed = signalPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        throw new ValidationError('invalid temporal.signal payload', {
          detail: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', '),
        });
      }
      const { workflowId, runId, signal, input } = parsed.data;
      const envelope: RelayedSignal = {
        dedupeKey: row.dedupeKey ?? row.id,
        ...(input === undefined ? {} : { input }),
      };
      await deps.workflows.getHandle(workflowId, runId).signal(signal, envelope);
    },
  };
}
