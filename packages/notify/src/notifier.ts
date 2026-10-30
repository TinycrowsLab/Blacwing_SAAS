import { SpanStatusCode, trace } from '@opentelemetry/api';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  isAuditedNotificationEvent,
  NOTIFICATION_RECIPIENTS_MAX,
  outboxPayloadSchema,
  type NotificationChannelKind,
  type NotificationRequest,
  notificationRequestSchema,
  type NotifySendPayload,
} from '@blackwing/contracts';
import {
  type Database,
  memberships,
  notificationChannels,
  OutboxDuplicateError,
  outbox,
  toAuditSqlTx,
  type TenantTx,
  users,
  withOutbox,
  withTenant,
} from '@blackwing/db';
import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { createLogger, type Logger } from '@blackwing/logger';

import { NOOP_NOTIFY_METRICS, type NotifyMetrics } from './metrics.js';
import {
  type DeliveryPlan,
  planDeliveries,
  type PlannedDelivery,
  type SkippedChannel,
} from './plan.js';

import type { ChannelRegistry } from './channel.js';
import type { AuditEmitter } from '@blackwing/audit';

/**
 * The `notify()` core (NOTIFY-002, CONTEXT_PACK §3.1, §7, §8.6, §8.7, §8.8). A caller hands over a request; the
 * core, inside that tenant's context, loads the tenant's channels, plans one delivery per routed channel and writes
 * one `notify.send` outbox row each, in the same transaction. It never calls a provider: the relay (WORKFLOW-012)
 * and the delivery worker (NOTIFY-012) do, so a caller is never blocked on third-party latency.
 *
 * Guarantees:
 *  - fail closed: an invalid request, or no tenant context, writes nothing;
 *  - tenant isolation: only the request's tenant's channels and admins are read, and each planned delivery is
 *    re-checked against the tenant;
 *  - at-least-once with dedupe: a repeated request (same `dedupeKey`) enqueues nothing new, because each delivery's
 *    outbox dedupe key is unique per tenant. That is permanent, not a time window: a caller that wants a fresh
 *    notice for a recurring event must send a new key;
 *  - no silent drop: a request that routes nowhere is audited (`notification.unrouted`) and metered;
 *  - gate and kill requests are audited (`notification.requested`) in the same transaction.
 */

/** A `dryRun` delivery: what would be enqueued, with nothing written and nothing sent. */
export interface DryRunDelivery {
  readonly channelId: string | null;
  readonly payload: NotifySendPayload;
}

export type NotifyOutcome =
  | {
      readonly status: 'enqueued';
      readonly notificationId: string;
      readonly enqueued: number;
      readonly fallback: boolean;
      readonly skipped: readonly SkippedChannel[];
    }
  | { readonly status: 'deduplicated'; readonly notificationId: string }
  | {
      readonly status: 'unrouted';
      readonly notificationId: string;
      readonly skipped: readonly SkippedChannel[];
    }
  | {
      readonly status: 'dry_run';
      readonly notificationId: string;
      readonly rendered: readonly DryRunDelivery[];
      readonly fallback: boolean;
      readonly skipped: readonly SkippedChannel[];
    };

export interface NotifyOptions {
  /** Render and route, then return what would be enqueued. Writes nothing and sends nothing. */
  readonly dryRun?: boolean;
}

export interface Notifier {
  /** Accepts the untrusted input and parses it; a request that does not parse is refused with nothing written. */
  notify(request: unknown, options?: NotifyOptions): Promise<NotifyOutcome>;
}

export interface NotifierDeps {
  readonly db: Database;
  readonly registry: ChannelRegistry;
  readonly audit: AuditEmitter;
  /** The console origin (https, no credentials), used for truncation links. */
  readonly consoleUrl: string;
  readonly metrics?: NotifyMetrics;
  readonly logger?: Logger;
}

const TRACER_NAME = '@blackwing/notify';
const SPAN_NAME = 'notify.request';
const ORG_ADMIN_ROLE = 'org_admin';

/** Validates the console origin once at wiring time. A bad origin is a configuration error, not a request error. */
function assertConsoleUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('consoleUrl must be an absolute https URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  ) {
    throw new Error('consoleUrl must be an https URL with no credentials');
  }
  return value;
}

/** Builds the notify core over `deps`. */
export function createNotifier(deps: NotifierDeps): Notifier {
  const consoleUrl = assertConsoleUrl(deps.consoleUrl);
  const metrics = deps.metrics ?? NOOP_NOTIFY_METRICS;
  const logger = deps.logger ?? createLogger('@blackwing/notify');
  const tracer = trace.getTracer(TRACER_NAME);

  /** Reads what routing needs, inside the tenant's transaction: the tenant's channels and its org admins. */
  async function loadPlan(
    tx: TenantTx,
    request: NotificationRequest,
    notificationId: string,
  ): Promise<DeliveryPlan> {
    const channels = await tx
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.tenantId, request.tenantId))
      .orderBy(asc(notificationChannels.createdAt), asc(notificationChannels.id));
    const admins = await tx
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, request.tenantId),
          eq(users.status, 'active'),
          sql`${ORG_ADMIN_ROLE} = ANY(${memberships.roles})`,
        ),
      )
      .orderBy(asc(users.email))
      .limit(NOTIFICATION_RECIPIENTS_MAX);
    return planDeliveries({
      request,
      notificationId,
      channels,
      registry: deps.registry,
      consoleUrl,
      adminRecipients: admins.map((admin) => admin.email),
    });
  }

  /** Dedupe keys of `keys` that already have an outbox row in this tenant. */
  async function existingDedupeKeys(
    tx: TenantTx,
    tenantId: string,
    keys: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (keys.length === 0) return new Set();
    const rows = await tx
      .select({ dedupeKey: outbox.dedupeKey })
      .from(outbox)
      .where(and(eq(outbox.tenantId, tenantId), inArray(outbox.dedupeKey, [...keys])));
    return new Set(rows.flatMap((row) => (row.dedupeKey === null ? [] : [row.dedupeKey])));
  }

  async function writeOutbox(
    tx: TenantTx,
    notificationId: string,
    deliveries: readonly PlannedDelivery[],
  ): Promise<void> {
    await withOutbox(
      tx,
      deliveries.map((delivery) => ({
        type: 'notify.send',
        aggregateType: 'notification',
        aggregateId: notificationId,
        // The outbox's own JSON-object schema: the same payload, typed as the outbox stores it.
        payload: outboxPayloadSchema.parse(delivery.payload),
        dedupeKey: delivery.dedupeKey,
      })),
      { logger },
    );
  }

  async function run(request: NotificationRequest, options: NotifyOptions): Promise<NotifyOutcome> {
    const notificationId = newId();
    metrics.requested(request.event);

    if (options.dryRun === true) {
      const plan = await withTenant(deps.db, request.tenantId, (tx) =>
        loadPlan(tx, request, notificationId),
      );
      return {
        status: 'dry_run',
        notificationId,
        rendered: plan.deliveries.map((delivery) => ({
          channelId: delivery.channelId,
          payload: delivery.payload,
        })),
        fallback: plan.fallback,
        skipped: plan.skipped,
      };
    }

    const enqueuedKinds: NotificationChannelKind[] = [];
    let outcome: NotifyOutcome;
    try {
      outcome = await withTenant(deps.db, request.tenantId, async (tx): Promise<NotifyOutcome> => {
        const plan = await loadPlan(tx, request, notificationId);
        const duplicates = await existingDedupeKeys(
          tx,
          request.tenantId,
          plan.deliveries.map((delivery) => delivery.dedupeKey),
        );
        const fresh = plan.deliveries.filter((delivery) => !duplicates.has(delivery.dedupeKey));

        if (plan.deliveries.length > 0 && fresh.length === 0) {
          return { status: 'deduplicated', notificationId };
        }
        if (fresh.length > 0) {
          await writeOutbox(tx, notificationId, fresh);
          enqueuedKinds.push(...fresh.map((delivery) => delivery.kind));
        }

        if (plan.unrouted) {
          await deps.audit.emitAuditInTx(toAuditSqlTx(tx), {
            tenantId: request.tenantId,
            action: 'notification.unrouted',
            actor: { type: 'system' },
            target: { type: 'tenant', id: request.tenantId },
            outcome: 'failure',
            reason: 'no channel or fallback recipient for this notification',
            metadata: {
              event: request.event,
              severity: request.severity,
              skipped: plan.skipped.length,
            },
          });
          return { status: 'unrouted', notificationId, skipped: plan.skipped };
        }
        if (isAuditedNotificationEvent(request.event)) {
          await deps.audit.emitAuditInTx(toAuditSqlTx(tx), {
            tenantId: request.tenantId,
            action: 'notification.requested',
            actor: { type: 'system' },
            target: { type: 'tenant', id: request.tenantId },
            outcome: 'success',
            metadata: {
              event: request.event,
              severity: request.severity,
              enqueued: fresh.length,
              fallback: plan.fallback,
            },
            ...(request.runId === undefined ? {} : { runId: request.runId }),
          });
        }
        return {
          status: 'enqueued',
          notificationId,
          enqueued: fresh.length,
          fallback: plan.fallback,
          skipped: plan.skipped,
        };
      });
    } catch (error) {
      // A concurrent request with the same key committed first: its rows are the delivery.
      if (error instanceof OutboxDuplicateError) return { status: 'deduplicated', notificationId };
      throw error;
    }

    for (const kind of enqueuedKinds) metrics.enqueued(kind);
    if (outcome.status === 'unrouted') metrics.unrouted();
    return outcome;
  }

  return {
    async notify(input, options = {}) {
      const parsed = notificationRequestSchema.safeParse(input);
      if (!parsed.success) {
        throw new ValidationError('invalid notification request', {
          detail: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', '),
        });
      }
      const request = parsed.data;
      return tracer.startActiveSpan(SPAN_NAME, async (span) => {
        span.setAttributes({
          'notify.event': request.event,
          'notify.dry_run': options.dryRun === true,
        });
        try {
          const outcome = await run(request, options);
          span.setAttribute('notify.outcome', outcome.status);
          logger.info(
            { tenantId: request.tenantId, event: request.event, outcome: outcome.status },
            'notify.request',
          );
          return outcome;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    },
  };
}
