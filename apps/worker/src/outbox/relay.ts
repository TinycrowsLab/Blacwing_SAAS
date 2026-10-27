import { SpanStatusCode, trace } from '@opentelemetry/api';

import { OUTBOX_MESSAGE_TYPES, type OutboxMessageType } from '@blackwing/contracts';
import {
  type ClaimedOutboxRow,
  type Database,
  outboxBacklog,
  type OutboxClaim,
  withOutboxClaim,
  withTenant,
} from '@blackwing/db';
import { createLogger, type Logger, redactText } from '@blackwing/logger';

import { toAuditSqlTx } from './audit-tx.js';
import { outboxBackoffMs } from './backoff.js';

import type { OutboxRelayConfig } from './config.js';
import type { OutboxDispatcher, OutboxRelayMetrics } from './ports.js';
import type { AuditEmitter } from '@blackwing/audit';

const tracer = trace.getTracer('@blackwing/worker');

const BACKLOG_REFRESH_MS = 10_000;
const MS_PER_SECOND = 1_000;
const LAST_ERROR_MAX = 500;
/** `last_error` of a row whose tenant was suspended or deleted before delivery. */
export const TENANT_INACTIVE = 'tenant_inactive';

export interface OutboxRelayDeps {
  readonly config: OutboxRelayConfig;
  /** Connection as the `bw_relay` login: claims and settles rows across tenants, nothing else. */
  readonly relayDb: Database;
  /** App-role connection: every dispatch side effect runs under `withTenant` on it. */
  readonly appDb: Database;
  readonly dispatchers: Readonly<Record<OutboxMessageType, OutboxDispatcher>>;
  /** False for a suspended or deleted tenant: its rows are failed, not delivered. A lookup error is a retry. */
  readonly isTenantActive: (tenantId: string) => Promise<boolean>;
  /** Writes the `outbox.delivery_failed` audit event (`createAuditEmitter()`). */
  readonly audit: Pick<AuditEmitter, 'emitAuditInTx'>;
  readonly metrics: OutboxRelayMetrics;
  readonly logger?: Logger;
  /** Test seam for the backoff jitter. */
  readonly random?: () => number;
}

type Delivery =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'failed'; readonly error: unknown };

/** A running (or startable) relay. */
export interface OutboxRelay {
  /** Claims and delivers one batch; resolves to the number of rows it settled. */
  pollOnce(): Promise<number>;
  /** Starts the polling loop (idempotent). */
  start(): void;
  /** Stops the loop and waits for the batch in flight to finish. */
  stop(): Promise<void>;
}

/** Last-error text for the row: redacted (messages can echo destination responses) and bounded. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactText(text).slice(0, LAST_ERROR_MAX);
}

/**
 * The outbox relay (WORKFLOW-012, F12, F34, §8.8): polls due `pending` rows with `FOR UPDATE SKIP LOCKED`,
 * delivers each to its destination under the row's tenant, then marks it `dispatched` in the claiming
 * transaction. Delivery is at least once: a crash before commit leaves the row `pending`, and the
 * destinations dedupe. A failing row backs off on the database clock and becomes `failed` (audited,
 * counted, alerted) after `maxAttempts`, without blocking the rows behind it.
 */
export function createOutboxRelay(deps: OutboxRelayDeps): OutboxRelay {
  const { config, metrics } = deps;
  const log = (deps.logger ?? createLogger('worker')).child({ component: 'outbox-relay' });
  const random = deps.random ?? Math.random;

  async function recordFailure(
    row: ClaimedOutboxRow,
    reason: string,
    attempts: number,
  ): Promise<void> {
    await withTenant(deps.appDb, row.tenantId, async (tx) => {
      await deps.audit.emitAuditInTx(toAuditSqlTx(tx), {
        tenantId: row.tenantId,
        action: 'outbox.delivery_failed',
        actor: { type: 'system', id: 'outbox-relay' },
        target: { type: 'tenant', id: row.tenantId },
        outcome: 'failure',
        reason,
        metadata: {
          outboxId: row.id,
          messageType: row.type,
          ...(row.aggregateId === null ? {} : { aggregateId: row.aggregateId }),
          attempts,
        },
        dedupeKey: `outbox-failed:${row.id}`,
      });
    });
  }

  /** Terminal failure: audit first, then mark. If the audit cannot be written the row retries, so it is never failed unaudited. */
  async function giveUp(
    claim: OutboxClaim,
    row: ClaimedOutboxRow,
    reason: string,
    lastError: string,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const fields = {
      tenantId: row.tenantId,
      type: row.type,
      aggregateId: row.aggregateId,
      attempts,
    };
    try {
      await recordFailure(row, reason, attempts);
    } catch (error) {
      log.error({ ...fields, err: error }, 'outbox failure could not be audited; will retry');
      await claim.markRetry(row.id, describeError(error), outboxBackoffMs(attempts, random));
      return;
    }
    await claim.markFailed(row.id, lastError);
    metrics.failed(row.type);
    log.error({ ...fields, alert: 'outbox_failed', reason }, 'outbox message failed permanently');
  }

  async function settle(claim: OutboxClaim, row: ClaimedOutboxRow): Promise<void> {
    const fields = {
      tenantId: row.tenantId,
      type: row.type,
      aggregateId: row.aggregateId,
      attempts: row.attempts,
    };
    const delivery = await tracer.startActiveSpan(
      'outbox.dispatch',
      async (span): Promise<Delivery> => {
        span.setAttributes({
          'outbox.id': row.id,
          'outbox.type': row.type,
          'outbox.attempts': row.attempts,
          'tenant.id': row.tenantId,
        });
        try {
          if (!(await deps.isTenantActive(row.tenantId))) return { kind: 'inactive' };
          await deps.dispatchers[row.type](row);
          return { kind: 'delivered' };
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          return { kind: 'failed', error };
        } finally {
          span.end();
        }
      },
    );

    if (delivery.kind === 'inactive') {
      await giveUp(claim, row, TENANT_INACTIVE, TENANT_INACTIVE);
    } else if (delivery.kind === 'delivered') {
      await claim.markDispatched(row.id);
      metrics.dispatched(row.type);
      metrics.dispatchLatency(Math.max(0, Date.now() - row.createdAt.getTime()) / MS_PER_SECOND);
      log.debug(fields, 'outbox message dispatched');
    } else if (row.attempts + 1 >= config.maxAttempts) {
      await giveUp(claim, row, 'max_attempts_exhausted', describeError(delivery.error));
    } else {
      const attempts = row.attempts + 1;
      await claim.markRetry(
        row.id,
        describeError(delivery.error),
        outboxBackoffMs(attempts, random),
      );
      metrics.retried(row.type);
      log.warn({ ...fields, attempts, err: delivery.error }, 'outbox dispatch failed; retrying');
    }
  }

  async function pollOnce(): Promise<number> {
    return withOutboxClaim(deps.relayDb, config.batchSize, async (claim) => {
      for (const row of claim.rows) await settle(claim, row);
      return claim.rows.length;
    });
  }

  async function refreshBacklog(): Promise<void> {
    const counts = await outboxBacklog(deps.relayDb);
    for (const type of OUTBOX_MESSAGE_TYPES) metrics.backlog(type, counts[type] ?? 0);
  }

  let loop: Promise<void> | undefined;
  let stopping: AbortController | undefined;

  function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
    });
  }

  async function run(signal: AbortSignal): Promise<void> {
    let lastBacklog = Number.NEGATIVE_INFINITY;
    while (!signal.aborted) {
      let processed = 0;
      try {
        processed = await pollOnce();
        if (Date.now() - lastBacklog >= BACKLOG_REFRESH_MS) {
          lastBacklog = Date.now();
          await refreshBacklog();
        }
      } catch (error) {
        // Destination or database trouble: nothing was lost (the claim rolled back); try again.
        log.error({ err: error }, 'outbox poll failed');
      }
      if (processed < config.batchSize) await pause(config.pollIntervalMs, signal);
    }
  }

  return {
    pollOnce,
    start() {
      if (loop !== undefined) return;
      stopping = new AbortController();
      loop = run(stopping.signal);
    },
    async stop() {
      stopping?.abort();
      await loop;
      loop = undefined;
    },
  };
}
