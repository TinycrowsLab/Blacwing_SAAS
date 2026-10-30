import { isAppError } from '@blackwing/errors';

import { matchesAuditExportFilters, parseAuditExportFilters } from './filters.js';
import {
  AuditExportSecretGoneError,
  type AuditExportAudit,
  type AuditExportMetrics,
  type AuditExportStore,
  type AuditExportSecretResolver,
  type AuditExportSubscription,
} from './ports.js';

import type { SiemConnector } from './connector.js';
import type { AuditEventInput } from '../draft.js';
import type { AuditSpanRunner } from '../ports.js';
import type { AuditExportFilters } from '@blackwing/contracts';

/**
 * The SIEM export dispatcher (AUDIT-004, CONTEXT_PACK §8.6, §8.8). One call exports one bounded window of one
 * subscription, reading the tenant's ledger strictly by `seq` after the cursor. It advances the cursor only to a
 * position the destination has confirmed, so the export is at-least-once: a crash or a failed delivery leaves
 * the cursor where it was and the same events are sent again.
 *
 * Fails closed: an unknown kind, a config the connector refuses, a credential that is gone or a paused or
 * errored subscription deliver nothing. Only a `deliver` that resolved with a valid `deliveredThrough` moves the
 * cursor. The subscription is auto-disabled (status `error`) when the configuration or the credential is
 * permanently unusable; a transient resolver error is rethrown so the activity retries.
 */

export interface AuditExportDeps {
  readonly store: AuditExportStore;
  /** The connector per kind. A kind without an implementation is refused (`unsupported_kind`). */
  readonly connectors: ReadonlyMap<string, SiemConnector>;
  readonly resolveSecret: AuditExportSecretResolver;
  /** Writes an audit event for a failure or a disable (the ledger, §8.8). */
  readonly audit: AuditExportAudit;
  readonly metrics: AuditExportMetrics;
  /** Events read per call; the connector's `maxBatchSize` chunks them further. Must be >= 1. */
  readonly batchSize: number;
  readonly span?: AuditSpanRunner;
}

export type AuditExportOutcome =
  /** Nothing new after the cursor. */
  | { readonly status: 'idle'; readonly cursorSeq: number; readonly delivered: 0 }
  /** The whole window was read and confirmed (or fully filtered). */
  | { readonly status: 'delivered'; readonly cursorSeq: number; readonly delivered: number }
  /** The destination confirmed only part of the window; the next call resumes at the cursor. */
  | { readonly status: 'partial'; readonly cursorSeq: number; readonly delivered: number }
  /** Not active (paused) or disabled by an earlier error: nothing was read. */
  | {
      readonly status: 'skipped';
      readonly reason: 'paused' | 'disabled';
      readonly cursorSeq: number;
      readonly delivered: 0;
    }
  /** A delivery failed: the cursor stayed at the last confirmed position. */
  | {
      readonly status: 'failed';
      readonly cursorSeq: number;
      readonly delivered: number;
      readonly reason: string;
    };

const SYSTEM_ACTOR = { type: 'system', id: 'audit-export' } as const;

/** A stable, non-secret label for a failure: the error code when there is one, else the class name. */
function failureReason(error: unknown): string {
  if (isAppError(error)) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

/** Chunks `items` into slices of at most `size` (size >= 1). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

export function createAuditExporter(
  deps: AuditExportDeps,
): (subscription: AuditExportSubscription) => Promise<AuditExportOutcome> {
  if (!Number.isInteger(deps.batchSize) || deps.batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  const span: AuditSpanRunner = deps.span ?? ((_name, fn) => fn());

  async function disable(subscription: AuditExportSubscription, reason: string): Promise<void> {
    await deps.store.setStatus({
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      status: 'error',
    });
    await deps.audit(auditInput(subscription, 'connector.configured', reason));
  }

  return (subscription) => span('audit.export.deliver', () => exportOnce(subscription));

  async function exportOnce(subscription: AuditExportSubscription): Promise<AuditExportOutcome> {
    const { tenantId, kind } = subscription;
    let cursor = subscription.cursorSeq;
    const skipped = (reason: 'paused' | 'disabled'): AuditExportOutcome => ({
      status: 'skipped',
      reason,
      cursorSeq: cursor,
      delivered: 0,
    });
    if (subscription.status === 'paused') return skipped('paused');
    if (subscription.status === 'error') return skipped('disabled');

    const connector = deps.connectors.get(kind);
    if (connector === undefined) {
      await disable(subscription, 'unsupported_kind');
      return skipped('disabled');
    }

    let filters: AuditExportFilters;
    let config: unknown;
    try {
      filters = parseAuditExportFilters(subscription.filters);
      config = connector.validate(subscription.config);
    } catch (error) {
      await disable(subscription, failureReason(error));
      return skipped('disabled');
    }

    const events = await deps.store.readEvents(tenantId, cursor, deps.batchSize);
    if (events.length === 0) {
      await reportBacklog(subscription, cursor);
      return { status: 'idle', cursorSeq: cursor, delivered: 0 };
    }

    // The credential is resolved at most once per call and only when something must be sent: an idle
    // subscription never touches the secret (and never writes a `secret.resolved` audit event).
    let secret: string | undefined;
    const credential = async (): Promise<string | undefined> => {
      if (secret !== undefined) return secret;
      try {
        secret = await deps.resolveSecret(tenantId, subscription.secretRef);
        return secret;
      } catch (error) {
        if (error instanceof AuditExportSecretGoneError) {
          await disable(subscription, 'secret_unavailable');
          return undefined;
        }
        throw error;
      }
    };

    let delivered = 0;
    for (const window of chunk(events, connector.maxBatchSize)) {
      const last = window.at(-1);
      if (last === undefined) continue;
      const batch = window.filter((event) => matchesAuditExportFilters(filters, event.action));

      if (batch.length === 0) {
        cursor = await advance(subscription, cursor, last.seq);
        continue;
      }

      const resolved = await credential();
      if (resolved === undefined) return skipped('disabled');

      let confirmed: number;
      try {
        const result = await connector.deliver(batch, { config, secret: resolved });
        confirmed = result.deliveredThrough;
      } catch (error) {
        deps.metrics.failed({ kind });
        await deps.audit(auditInput(subscription, 'export.generated', failureReason(error)));
        return { status: 'failed', cursorSeq: cursor, delivered, reason: failureReason(error) };
      }
      if (!Number.isSafeInteger(confirmed) || confirmed < cursor || confirmed > last.seq) {
        // A connector that confirms outside the window it was given is broken: nothing is moved.
        deps.metrics.failed({ kind });
        await deps.audit(auditInput(subscription, 'export.generated', 'invalid_delivery_position'));
        return {
          status: 'failed',
          cursorSeq: cursor,
          delivered,
          reason: 'invalid_delivery_position',
        };
      }

      const count = batch.filter((event) => event.seq <= confirmed).length;
      cursor = await advance(subscription, cursor, confirmed);
      delivered += count;
      deps.metrics.delivered({ kind }, count);
      if (confirmed < last.seq) {
        await reportBacklog(subscription, cursor);
        return { status: 'partial', cursorSeq: cursor, delivered };
      }
    }

    await reportBacklog(subscription, cursor);
    return { status: 'delivered', cursorSeq: cursor, delivered };
  }

  /** Moves the cursor to `to` (compare-and-set on `from`). A lost race means another runner moved it: stop. */
  async function advance(
    subscription: AuditExportSubscription,
    from: number,
    to: number,
  ): Promise<number> {
    if (to === from) return from;
    const moved = await deps.store.advanceCursor({
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      from,
      to,
    });
    if (!moved) throw new CursorRaceError(subscription.id);
    return to;
  }

  async function reportBacklog(
    subscription: AuditExportSubscription,
    cursor: number,
  ): Promise<void> {
    const head = await deps.store.headSeq(subscription.tenantId);
    const labels = { subscription: subscription.id };
    deps.metrics.cursor(labels, cursor);
    deps.metrics.backlog(labels, Math.max(0, head - cursor));
  }

  function auditInput(
    subscription: AuditExportSubscription,
    action: 'export.generated' | 'connector.configured',
    reason: string,
  ): AuditEventInput {
    return {
      tenantId: subscription.tenantId,
      action,
      actor: SYSTEM_ACTOR,
      target: { type: 'export', id: subscription.id },
      outcome: 'failure',
      reason,
      metadata: { kind: subscription.kind, cursorSeq: subscription.cursorSeq },
    };
  }
}

/** The compare-and-set on the cursor lost: another runner moved it, so this one must not keep sending. */
export class CursorRaceError extends Error {
  override readonly name = 'CursorRaceError';
  constructor(subscriptionId: string) {
    super(`audit export cursor for ${subscriptionId} moved concurrently`);
  }
}
