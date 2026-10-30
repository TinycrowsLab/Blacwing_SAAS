// In-memory fakes for the SIEM export unit tests: a ledger, a subscription store that enforces the same cursor rules
// as the database trigger, a fake destination connector and event builders.

import {
  AuditEventSchema,
  auditActionEntry,
  type AuditAction,
  type AuditEvent,
} from '@blackwing/contracts';

import { deriveAuditEventId } from '../draft.js';

import type { SiemConnector, SiemDeliveryResult, SiemTarget } from './connector.js';
import type {
  AuditExportKind,
  AuditExportMetrics,
  AuditExportStatus,
  AuditExportStore,
  AuditExportSubscription,
} from './ports.js';

export const TENANT = '01900000-0000-7000-8000-000000000001';
export const OTHER_TENANT = '01900000-0000-7000-8000-000000000002';
export const SUBSCRIPTION = '01900000-0000-7000-8000-0000000000a1';
export const SECRET_REF = `bw-secret://${TENANT}/01900000-0000-7000-8000-0000000000c1`;
export const SECRET_VALUE = 'hec-token-s3cr3t-value';

const SHA256_HEX = 64;
const HASH = 'b'.repeat(SHA256_HEX);
const GENESIS = '0'.repeat(SHA256_HEX);

/** A valid ledger event with `seq`, for `tenantId`, action `action`. */
export function makeEvent(
  seq: number,
  action: AuditAction = 'gate2.decided',
  tenantId = TENANT,
): AuditEvent {
  return AuditEventSchema.parse({
    id: deriveAuditEventId(tenantId, `event-${String(seq)}-${action}`),
    tenantId,
    seq,
    occurredAt: '2026-01-01T00:00:00.000Z',
    action,
    severity: auditActionEntry(action).defaultSeverity,
    actor: { type: 'user', id: 'usr_01j0000000000000000000000a', email: 'approver@example.test' },
    target: { type: 'run', id: '01900000-0000-7000-8000-0000000000b1' },
    outcome: 'success',
    metadata: { n: seq },
    prevHash: seq === 1 ? GENESIS : HASH,
    hash: HASH,
  });
}

/** An in-memory ledger for one tenant, ascending by seq. */
export class MemoryEvents {
  constructor(readonly events: AuditEvent[] = []) {}

  /** Appends `count` events (actions in `actions` cycled) to the ledger. */
  append(count: number, actions: readonly AuditAction[] = ['gate2.decided']): this {
    for (let i = 0; i < count; i += 1) {
      const seq = this.events.length + 1;
      this.events.push(makeEvent(seq, actions[i % actions.length] ?? 'gate2.decided'));
    }
    return this;
  }
}

/** In-memory subscription store with the same cursor rule as the database trigger (never backwards). */
export class MemoryExportStore implements AuditExportStore {
  readonly subs = new Map<string, AuditExportSubscription>();
  readonly audits: unknown[] = [];
  /** Every `advanceCursor` call, in order (for asserting the cursor moved only on success). */
  readonly cursorMoves: { from: number; to: number; ok: boolean }[] = [];

  constructor(private readonly ledger: MemoryEvents) {}

  put(sub: Partial<AuditExportSubscription> & { id?: string }): AuditExportSubscription {
    const row: AuditExportSubscription = {
      id: sub.id ?? SUBSCRIPTION,
      tenantId: sub.tenantId ?? TENANT,
      kind: sub.kind ?? 'splunk_hec',
      config: sub.config ?? { host: 'siem.example.test' },
      secretRef: sub.secretRef ?? SECRET_REF,
      cursorSeq: sub.cursorSeq ?? 0,
      status: sub.status ?? 'active',
      filters: sub.filters ?? {},
    };
    this.subs.set(row.id, row);
    return row;
  }

  load(tenantId: string, subscriptionId: string): Promise<AuditExportSubscription | undefined> {
    const row = this.subs.get(subscriptionId);
    return Promise.resolve(row?.tenantId === tenantId ? row : undefined);
  }

  headSeq(tenantId: string): Promise<number> {
    return Promise.resolve(this.ledger.events.findLast((e) => e.tenantId === tenantId)?.seq ?? 0);
  }

  readEvents(tenantId: string, afterSeq: number, limit: number): Promise<AuditEvent[]> {
    return Promise.resolve(
      this.ledger.events.filter((e) => e.tenantId === tenantId && e.seq > afterSeq).slice(0, limit),
    );
  }

  advanceCursor(input: {
    tenantId: string;
    subscriptionId: string;
    from: number;
    to: number;
  }): Promise<boolean> {
    const row = this.subs.get(input.subscriptionId);
    const ok =
      row?.tenantId === input.tenantId && row.cursorSeq === input.from && input.to >= input.from;
    this.cursorMoves.push({ from: input.from, to: input.to, ok });
    if (ok) this.subs.set(row.id, { ...row, cursorSeq: input.to });
    return Promise.resolve(ok);
  }

  setStatus(input: {
    tenantId: string;
    subscriptionId: string;
    status: AuditExportStatus;
  }): Promise<void> {
    const row = this.subs.get(input.subscriptionId);
    if (row?.tenantId === input.tenantId) this.subs.set(row.id, { ...row, status: input.status });
    return Promise.resolve();
  }

  get(id = SUBSCRIPTION): AuditExportSubscription {
    const row = this.subs.get(id);
    if (row === undefined) throw new Error('no subscription');
    return row;
  }
}

/** A recording metrics sink. */
export class MemoryMetrics implements AuditExportMetrics {
  readonly deliveredBatches: { kind: AuditExportKind; count: number }[] = [];
  readonly failures: AuditExportKind[] = [];
  readonly backlogs: number[] = [];
  readonly cursors: number[] = [];

  delivered(labels: { kind: AuditExportKind }, count: number): void {
    this.deliveredBatches.push({ kind: labels.kind, count });
  }

  failed(labels: { kind: AuditExportKind }): void {
    this.failures.push(labels.kind);
  }

  backlog(_labels: { subscription: string }, value: number): void {
    this.backlogs.push(value);
  }

  cursor(_labels: { subscription: string }, value: number): void {
    this.cursors.push(value);
  }
}

/** A destination that records every delivered event and can be told to fail or confirm less. */
export class FakeConnector implements SiemConnector<{ host: string }> {
  readonly kind = 'splunk_hec' as const;
  readonly delivered: AuditEvent[] = [];
  readonly calls: { seqs: number[]; secret: string }[] = [];
  /** Throws on the next `deliver` calls while > 0 (decremented per call). */
  failNext = 0;
  /** When set, confirms at most this seq of the batch (partial delivery). */
  confirmUpTo: number | undefined;
  /** When set, `deliver` confirms this (possibly invalid) position instead. */
  forcedPosition: number | undefined;

  constructor(readonly maxBatchSize = 500) {}

  validate(config: unknown): { host: string } {
    if (
      typeof config !== 'object' ||
      config === null ||
      typeof (config as { host?: unknown }).host !== 'string'
    ) {
      throw new Error('host required');
    }
    return { host: (config as { host: string }).host };
  }

  testConnection(): Promise<void> {
    return Promise.resolve();
  }

  deliver(
    batch: readonly AuditEvent[],
    target: SiemTarget<{ host: string }>,
  ): Promise<SiemDeliveryResult> {
    this.calls.push({ seqs: batch.map((e) => e.seq), secret: target.secret });
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('destination down'));
    }
    const last = batch.at(-1)?.seq ?? 0;
    if (this.forcedPosition !== undefined)
      return Promise.resolve({ deliveredThrough: this.forcedPosition });
    const through = this.confirmUpTo === undefined ? last : Math.min(last, this.confirmUpTo);
    for (const event of batch) if (event.seq <= through) this.delivered.push(event);
    return Promise.resolve({ deliveredThrough: through });
  }
}
