import { systemClock, type Clock } from '@blackwing/time';

import { appendToChain, createPgChainStore, type AuditChainStore } from './chain.js';
import {
  buildAuditDraft,
  parseAuditDraft,
  type AuditEventDraft,
  type AuditEventInput,
} from './draft.js';
import {
  AUDIT_OUTBOX_TYPE,
  type AuditEmitPath,
  type AuditMetadataSpill,
  type AuditMetrics,
  type AuditOutbox,
  type AuditOutboxMessage,
  type AuditSpanRunner,
  type AuditSqlTx,
} from './ports.js';

import type { AuditEvent } from '@blackwing/contracts';
import type { Redactor } from '@blackwing/errors';

export interface AuditEmitterDeps {
  /** Required for {@link AuditEmitter.emitAudit} (and `emit` without a tx). */
  readonly outbox?: AuditOutbox;
  /** Exact-value secret redactor from the SECRETS registry; the built-in patterns always run too. */
  readonly redact?: Redactor;
  /** Where metadata over the inline cap goes; without it, oversized metadata is rejected. */
  readonly spillMetadata?: AuditMetadataSpill;
  readonly metrics?: AuditMetrics;
  readonly span?: AuditSpanRunner;
  readonly clock?: Clock;
  /** Test seam: builds the chain store over a transaction (default: Postgres). */
  readonly chainStore?: (tx: AuditSqlTx) => AuditChainStore;
}

export interface AuditEmitter {
  /**
   * Builds the event and appends it to the tenant's chain inside the caller's transaction `tx`.
   * Any failure rejects, so the caller's transaction rolls back: a security action whose audit
   * event cannot be written does not happen. Resolves to `undefined` when the event (same
   * `dedupeKey`) was already in the ledger.
   */
  emitAuditInTx(tx: AuditSqlTx, input: AuditEventInput): Promise<AuditEvent | undefined>;
  /**
   * Writes one `audit.event` row to the transactional outbox. The relay appends it to the chain
   * later, with at-least-once delivery and per-aggregate ordering. A failed enqueue rejects.
   */
  emitAudit(input: AuditEventInput, options?: { readonly tx?: AuditSqlTx }): Promise<void>;
}

const noopMetrics: AuditMetrics = {
  emitted: () => undefined,
  failed: () => undefined,
};

const defaultSpan: AuditSpanRunner = (_name, fn) => fn();

/** Creates the audit emitter, the only sanctioned writer of the ledger (§8.8). */
export function createAuditEmitter(deps: AuditEmitterDeps = {}): AuditEmitter {
  const metrics = deps.metrics ?? noopMetrics;
  const span = deps.span ?? defaultSpan;
  const clock = deps.clock ?? systemClock;
  const chainStore = deps.chainStore ?? createPgChainStore;

  const draftOptions = {
    now: () => clock.now(),
    ...(deps.redact === undefined ? {} : { registryRedactor: deps.redact }),
    ...(deps.spillMetadata === undefined ? {} : { spill: deps.spillMetadata }),
  };

  async function run<T>(path: AuditEmitPath, fn: () => Promise<T>): Promise<T> {
    try {
      return await span('audit.emit', fn);
    } catch (error) {
      metrics.failed({ path });
      throw error;
    }
  }

  return {
    emitAuditInTx(tx, input) {
      return run('sync', async () => {
        const draft = await buildAuditDraft(input, draftOptions);
        const result = await appendToChain(chainStore(tx), draft);
        metrics.emitted({ action: draft.action, path: 'sync' });
        return result.event;
      });
    },
    emitAudit(input, options = {}) {
      return run('outbox', async () => {
        const { outbox } = deps;
        if (outbox === undefined) {
          throw new Error('audit emitter has no outbox: pass `outbox` to createAuditEmitter');
        }
        const draft = await buildAuditDraft(input, draftOptions);
        await outbox.enqueue(
          toOutboxMessage(draft),
          options.tx === undefined ? undefined : { tx: options.tx },
        );
        metrics.emitted({ action: draft.action, path: 'outbox' });
      });
    },
  };
}

/** The outbox row for a draft. Aggregate and dedupe key make relay ordering and retries safe. */
export function toOutboxMessage(draft: AuditEventDraft): AuditOutboxMessage {
  return {
    tenantId: draft.tenantId,
    type: AUDIT_OUTBOX_TYPE,
    aggregateType: draft.target.type,
    aggregateId: draft.target.id,
    dedupeKey: draft.id,
    payload: draft,
  };
}

/**
 * The relay's entry point (WORKFLOW-012): appends the payload of one claimed `audit.event` outbox
 * row to the chain inside the relay's per-message transaction (tenant context set). Re-validates the
 * payload, so a tampered or malformed row fails closed; a redelivered row is a no-op.
 */
export async function appendAuditOutboxPayload(
  tx: AuditSqlTx,
  payload: unknown,
  deps: Pick<AuditEmitterDeps, 'chainStore' | 'metrics'> = {},
): Promise<AuditEvent | undefined> {
  const draft = parseAuditDraft(payload);
  const result = await appendToChain((deps.chainStore ?? createPgChainStore)(tx), draft);
  (deps.metrics ?? noopMetrics).emitted({ action: draft.action, path: 'outbox' });
  return result.event;
}
