import { createHash } from 'node:crypto';

import {
  AUDIT_GENESIS_PREV_HASH,
  AuditEventSchema,
  type AuditAction,
  type AuditActor,
  type AuditEvent,
  type AuditMetadata,
  type AuditMetadataRef,
  type AuditOutcome,
  type AuditSeverity,
  type AuditTarget,
  auditActionEntry,
  auditActionSchema,
  canonicalJson,
  measureAuditMetadata,
} from '@blackwing/contracts';
import { TenantContextMissingError, type Redactor } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { AuditEventInvalidError } from './errors.js';
import { createTextRedactor, redactValue, RedactionDepthError } from './redact.js';

import type { AuditMetadataSpill } from './ports.js';

/** What a producer hands to the helper: an event without its identity, time or chain fields. */
export interface AuditEventInput {
  /** The tenant whose ledger receives the event. Required: there is no default tenant. */
  readonly tenantId: string;
  readonly action: AuditAction;
  /** Defaults to the catalogue severity of `action`; may be raised, never lowered. */
  readonly severity?: AuditSeverity;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly outcome: AuditOutcome;
  readonly reason?: string;
  readonly metadata?: AuditMetadata;
  readonly traceId?: string;
  readonly runId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Defaults to now. Informational: ordering is `seq`. */
  readonly occurredAt?: string | Date;
  /**
   * Makes a retried producer idempotent: the event id is derived from `(tenantId, dedupeKey)`, so a
   * second emit with the same key resolves to the same ledger row and is a no-op.
   */
  readonly dedupeKey?: string;
}

/** An event as the chain appender takes it: validated and redacted, with an id, but no chain fields. */
export type AuditEventDraft = Omit<AuditEvent, 'prevHash' | 'hash' | 'seq'>;

const DEDUPE_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const ID_HEX_LENGTH = 32;
/** Hex offsets of the version nibble and the variant nibble in the 32-digit form. */
const VERSION_NIBBLE = 12;
const VARIANT_NIBBLE = 16;
const VARIANTS = ['8', '9', 'a', 'b'] as const;
/**
 * The event id for a `(tenantId, dedupeKey)` pair: the first 128 bits of
 * `SHA-256("bw-audit-event" NUL tenantId NUL dedupeKey)` with the UUIDv7 version nibble and an
 * RFC 9562 variant nibble set, so it passes the event schema. The timestamp bits are not a time;
 * ordering is `seq`. The ledger's primary key on `id` then makes a repeated key a no-op at append.
 */
export function deriveAuditEventId(tenantId: string, dedupeKey: string): string {
  if (!DEDUPE_KEY_PATTERN.test(dedupeKey)) {
    throw new AuditEventInvalidError('dedupeKey must be 1-255 printable ASCII characters');
  }
  const hex = createHash('sha256')
    .update(`bw-audit-event\0${tenantId}\0${dedupeKey}`, 'utf8')
    .digest('hex')
    .slice(0, ID_HEX_LENGTH);
  const variant =
    VARIANTS[Number.parseInt(hex.charAt(VARIANT_NIBBLE), 16) % VARIANTS.length] ?? '8';
  const digits = `${hex.slice(0, VERSION_NIBBLE)}7${hex.slice(VERSION_NIBBLE + 1, VARIANT_NIBBLE)}${variant}${hex.slice(VARIANT_NIBBLE + 1)}`;
  return digits.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

/** Zeroed chain fields, used only to run the full event schema over a draft. */
const PLACEHOLDER_CHAIN = {
  seq: 1,
  prevHash: AUDIT_GENESIS_PREV_HASH,
  hash: '0'.repeat(AUDIT_GENESIS_PREV_HASH.length),
} as const;

/** Validates an outbox payload back into a draft; used by the relay path. */
export function parseAuditDraft(payload: unknown): AuditEventDraft {
  const parsed = AuditEventSchema.safeParse(
    typeof payload === 'object' && payload !== null
      ? { ...payload, ...PLACEHOLDER_CHAIN }
      : payload,
  );
  if (!parsed.success) {
    throw new AuditEventInvalidError(describeIssues(parsed.error));
  }
  return stripChain(parsed.data);
}

function stripChain(event: AuditEvent): AuditEventDraft {
  const draft: Partial<AuditEvent> = { ...event };
  delete draft.prevHash;
  delete draft.hash;
  delete draft.seq;
  return draft as AuditEventDraft;
}

/** Failure paths and messages of a schema error, never the offending values. */
function describeIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(event)'}: ${issue.message}`)
    .join('; ');
}

export interface BuildDraftOptions {
  readonly registryRedactor?: Redactor;
  readonly spill?: AuditMetadataSpill;
  readonly now: () => Date;
  readonly newEventId?: () => string;
}

/**
 * Turns producer input into a draft: tenant check (fail closed), redaction, id and time, large
 * metadata moved out by reference, then the full `AuditEventSchema` (rejects with
 * `AUDIT_EVENT_INVALID`). Redaction happens before validation and before any size decision, so
 * neither the draft, the digest of spilled metadata, nor an error message can carry a secret.
 */
export async function buildAuditDraft(
  input: AuditEventInput,
  options: BuildDraftOptions,
): Promise<AuditEventDraft> {
  const tenantId: unknown = input.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TenantContextMissingError('audit event has no tenant');
  }
  if (!auditActionSchema.safeParse(input.action).success) {
    throw new AuditEventInvalidError('action: not a catalogued audit action');
  }
  const redactText = createTextRedactor(options.registryRedactor);
  let redacted: {
    reason: unknown;
    metadata: unknown;
    userAgent: unknown;
    actor: unknown;
    target: unknown;
  };
  try {
    // Free-form parts only: enum-valued fields (`type`, `outcome`) must stay valid even when the
    // registry redactor is down and every string it sees becomes the marker.
    redacted = {
      reason: redactValue(input.reason, redactText),
      metadata: redactValue(input.metadata ?? {}, redactText),
      userAgent: redactValue(input.userAgent, redactText),
      actor: redactIdentity(input.actor, redactText),
      target: redactIdentity(input.target, redactText),
    };
  } catch (error) {
    if (error instanceof RedactionDepthError) {
      throw new AuditEventInvalidError(`metadata: ${error.message}`);
    }
    throw error;
  }
  const occurredAt = resolveOccurredAt(input.occurredAt, options.now);
  const id =
    input.dedupeKey === undefined
      ? (options.newEventId ?? newId)()
      : deriveAuditEventId(tenantId, input.dedupeKey);

  let metadata = redacted.metadata as AuditMetadata;
  let metadataRef: AuditMetadataRef | undefined;
  const measured = tryMeasure(metadata);
  if (measured !== undefined && !measured.fitsInline && options.spill !== undefined) {
    const sha256 = createHash('sha256').update(canonicalJson(metadata), 'utf8').digest('hex');
    const evidenceKey = await options.spill({
      tenantId,
      metadata,
      sha256,
      sizeBytes: measured.sizeBytes,
    });
    metadataRef = { evidenceKey, sha256, sizeBytes: measured.sizeBytes };
    metadata = {};
  }

  const candidate = {
    id,
    tenantId,
    occurredAt,
    action: input.action,
    severity: input.severity ?? auditActionEntry(input.action).defaultSeverity,
    actor: redacted.actor,
    target: redacted.target,
    outcome: input.outcome,
    ...(redacted.reason === undefined ? {} : { reason: redacted.reason }),
    metadata,
    ...(metadataRef === undefined ? {} : { metadataRef }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    ...(redacted.userAgent === undefined ? {} : { userAgent: redacted.userAgent }),
    ...PLACEHOLDER_CHAIN,
  };
  const parsed = AuditEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AuditEventInvalidError(describeIssues(parsed.error));
  }
  return stripChain(parsed.data);
}

/** Redacts the free-text identifiers of an actor or target; the e-mail and `type` are left alone. */
function redactIdentity<T extends object>(value: T, redactText: (text: string) => string): T {
  const output = { ...value } as Record<string, unknown>;
  for (const key of ['id', 'tokenId']) {
    const member = output[key];
    if (typeof member === 'string') output[key] = redactText(member);
  }
  return output as T;
}

function resolveOccurredAt(value: string | Date | undefined, now: () => Date): string {
  const date = value === undefined ? now() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AuditEventInvalidError('occurredAt: not a valid timestamp');
  }
  // Millisecond UTC, the only spelling the schema accepts, so the stored timestamp reproduces it.
  return date.toISOString();
}

/** Canonical size of metadata, or `undefined` when it is not canonicalisable (validation reports it). */
function tryMeasure(metadata: AuditMetadata) {
  try {
    return measureAuditMetadata(metadata);
  } catch {
    return undefined;
  }
}
