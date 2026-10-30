import type { AuditEventInput } from '../draft.js';
import type { AuditEvent } from '@blackwing/contracts';
import type { AUDIT_EXPORT_KINDS } from '@blackwing/db';

/** The destination kinds the framework knows (the same set the database CHECK allows). */
export type AuditExportKind = (typeof AUDIT_EXPORT_KINDS)[number];

export type AuditExportStatus = 'active' | 'paused' | 'error';

/** A subscription as the dispatcher sees it: one tenant, one destination, one cursor. */
export interface AuditExportSubscription {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: AuditExportKind;
  readonly config: unknown;
  readonly secretRef: string;
  /** Highest `audit_events.seq` the destination has confirmed. */
  readonly cursorSeq: number;
  readonly status: AuditExportStatus;
  readonly filters: unknown;
}

/**
 * Persistence of the export. Every method is tenant-scoped (RLS): the adapter runs it under `withTenant`.
 * `advanceCursor` moves the cursor only from the value the caller read (compare-and-set), so two runners can
 * never both claim the same window; it returns `false` when the cursor is no longer at `from`.
 */
export interface AuditExportStore {
  /** The subscription in `tenantId`, or `undefined` when it is missing or belongs to another tenant. */
  load(tenantId: string, subscriptionId: string): Promise<AuditExportSubscription | undefined>;
  /** The chain head (highest `seq`) of the tenant's ledger, `0` when empty. */
  headSeq(tenantId: string): Promise<number>;
  /** Up to `limit` events with `seq > afterSeq`, ascending by `seq`. */
  readEvents(tenantId: string, afterSeq: number, limit: number): Promise<AuditEvent[]>;
  advanceCursor(input: {
    readonly tenantId: string;
    readonly subscriptionId: string;
    readonly from: number;
    readonly to: number;
  }): Promise<boolean>;
  setStatus(input: {
    readonly tenantId: string;
    readonly subscriptionId: string;
    readonly status: AuditExportStatus;
  }): Promise<void>;
}

/** Resolves a `secret_ref` to its plaintext for one delivery (the SECRETS resolve path, §8.7). */
export type AuditExportSecretResolver = (tenantId: string, secretRef: string) => Promise<string>;

/**
 * Thrown by a resolver when the credential is gone for good (the secret was shredded, or the reference names
 * nothing in the tenant). The subscription is then auto-disabled instead of retried forever.
 */
export class AuditExportSecretGoneError extends Error {
  override readonly name = 'AuditExportSecretGoneError';
}

/** The metrics of the export (`audit_export_delivered_total{kind}`, `audit_export_backlog{subscription}`, ...). */
export interface AuditExportMetrics {
  delivered(labels: { readonly kind: AuditExportKind }, count: number): void;
  backlog(labels: { readonly subscription: string }, value: number): void;
  cursor(labels: { readonly subscription: string }, value: number): void;
  failed(labels: { readonly kind: AuditExportKind }): void;
}

export type AuditExportAudit = (input: AuditEventInput) => Promise<void>;
