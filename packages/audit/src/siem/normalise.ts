import type { AuditActor, AuditEvent, AuditTarget } from '@blackwing/contracts';

/**
 * The connector-agnostic record of one audit event (AUDIT-004, CONTEXT_PACK §8.8): the fields an ECS-aware SIEM
 * indexes natively (`@timestamp`, `event.*`, `user.*`, `source.ip`, `user_agent.original`, `trace.id`,
 * `organization.id`) plus a `blackwing.*` block for the chain fields and the rest. Connectors serialise this
 * shape (CEF maps from the same fields). Nothing here is a secret the producer did not already redact (§8.7).
 */
export interface SiemRecord {
  readonly '@timestamp': string;
  readonly event: {
    readonly id: string;
    readonly action: string;
    readonly outcome: 'success' | 'failure';
    readonly kind: 'event';
    readonly category: readonly ['audit'];
    readonly reason?: string;
  };
  readonly user?: { readonly id: string; readonly email?: string };
  readonly source?: { readonly ip: string };
  readonly user_agent?: { readonly original: string };
  readonly trace?: { readonly id: string };
  readonly organization: { readonly id: string };
  readonly blackwing: {
    readonly seq: number;
    readonly hash: string;
    readonly prev_hash: string;
    readonly severity: AuditEvent['severity'];
    readonly actor: { readonly type: AuditActor['type'] };
    readonly target: AuditTarget;
    readonly run_id?: string;
    readonly metadata: AuditEvent['metadata'];
    readonly metadata_ref?: AuditEvent['metadataRef'];
  };
  /** The canonical event exactly as the ledger stores it (what `hash` covers). */
  readonly raw: AuditEvent;
}

/**
 * Maps a ledger event to the connector-agnostic record. A pure function: the same event always maps to the same
 * record, so a re-delivered event is byte-identical and a SIEM can de-duplicate on `event.id` / `blackwing.seq`.
 * `denied` is an `outcome: failure` in ECS; the exact outcome stays in `raw`.
 */
export function toSiemRecord(event: AuditEvent): SiemRecord {
  const { actor } = event;
  const user =
    actor.type === 'user' || actor.type === 'operator' || actor.type === 'service'
      ? {
          id: actor.id,
          ...(actor.type !== 'service' && actor.email !== undefined ? { email: actor.email } : {}),
        }
      : undefined;
  return {
    '@timestamp': event.occurredAt,
    event: {
      id: event.id,
      action: event.action,
      outcome: event.outcome === 'success' ? 'success' : 'failure',
      kind: 'event',
      category: ['audit'],
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    },
    ...(user === undefined ? {} : { user }),
    ...(event.ip === undefined ? {} : { source: { ip: event.ip } }),
    ...(event.userAgent === undefined ? {} : { user_agent: { original: event.userAgent } }),
    ...(event.traceId === undefined ? {} : { trace: { id: event.traceId } }),
    organization: { id: event.tenantId },
    blackwing: {
      seq: event.seq,
      hash: event.hash,
      prev_hash: event.prevHash,
      severity: event.severity,
      actor: { type: actor.type },
      target: event.target,
      ...(event.runId === undefined ? {} : { run_id: event.runId }),
      metadata: event.metadata,
      ...(event.metadataRef === undefined ? {} : { metadata_ref: event.metadataRef }),
    },
    raw: event,
  };
}
