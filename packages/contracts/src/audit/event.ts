import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { isoDateTimeSchema, sha256HexSchema, uuidV7Schema } from '../primitives.js';
import {
  AUDIT_SEVERITY_RANK,
  auditActionEntry,
  auditActionSchema,
  auditSeveritySchema,
} from './actions.js';
import { canonicalJson, CanonicalJsonError, isWellFormedString, utf8ByteLength } from './jcs.js';

/**
 * The canonical audit event (AUDIT-001, CONTEXT_PACK §8.8).
 *
 * One shape for every producer (api, worker, egress gateway, model gateway, session manager), so the
 * ledger is consistent, queryable and exportable. Persistence and the hash chain are AUDIT-002;
 * emission is AUDIT-003. This module fixes the contract both build on.
 *
 * Rules that are part of the contract:
 * - `metadata` is REDACTED BY THE PRODUCER before the event is built (§8.7). The ledger is
 *   append-only, so a secret written here can never be removed. Record references (secret ref ids,
 *   evidence keys), never values. The only PII the event carries is the actor's e-mail (lawful audit
 *   basis).
 * - Every string is NFC-normalised before validation and hashing, so the same text hashes the same
 *   in every language.
 * - `metadata` is at most {@link AUDIT_METADATA_MAX_BYTES} bytes of canonical JSON. Larger payloads go
 *   to the evidence store and the event carries `metadataRef` (key, digest, size) instead.
 * - `occurredAt` is producer wall time and is informational. Ordering is `seq` and the hash chain,
 *   never the clock.
 * - `hash` is SHA-256 over the JCS (RFC 8785) form of every other field ({@link auditEventHashInput}).
 */

/** Largest allowed canonical-JSON size of `metadata`, in UTF-8 bytes. */
export const AUDIT_METADATA_MAX_BYTES = 16_384;

/** Hex length of a SHA-256 digest. */
const SHA256_HEX_LENGTH = 64;

/** Longest e-mail address (RFC 5321 path limit). */
const EMAIL_MAX = 320;

/** Longest stored User-Agent header. */
const USER_AGENT_MAX = 1024;

/** `prevHash` of the first event in a chain. */
export const AUDIT_GENESIS_PREV_HASH = '0'.repeat(SHA256_HEX_LENGTH);

/** Largest `seq`: kept within IEEE-754 safe integers so JCS numbers stay exact in every language. */
export const AUDIT_SEQ_MAX = Number.MAX_SAFE_INTEGER;

/** Free-form identifiers (actor ids, token ids, target ids): printable ASCII without spaces. */
const auditIdentifierSchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/, 'must be 1-255 printable ASCII characters without spaces');

/** A canonical lowercase UUID of any version (tenant ids). */
const lowercaseUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'must be a lowercase UUID',
  );

/** A prefixed public id as `@blackwing/ids` produces it, e.g. `run_01j...`. */
const publicIdSchema = z
  .string()
  .regex(/^[a-z]{1,16}_[0-9a-hjkmnp-tv-z]{26}$/, 'must be a prefixed public id');

const emailSchema = z.email().max(EMAIL_MAX);

/** Who did it. `anonymous` (an unauthenticated login attempt, say) carries no identity at all. */
export const auditActorSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('user'),
    id: auditIdentifierSchema,
    email: emailSchema.optional(),
    tokenId: auditIdentifierSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('operator'),
    id: auditIdentifierSchema,
    email: emailSchema.optional(),
    tokenId: auditIdentifierSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('service'),
    id: auditIdentifierSchema,
    tokenId: auditIdentifierSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('system'),
    id: auditIdentifierSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('anonymous'),
  }),
]);
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditActorType = AuditActor['type'];

/** What the action was done to. Additive-only, like the action catalogue. */
export const auditTargetTypeSchema = z.enum([
  'tenant',
  'user',
  'api_token',
  'asset',
  'standing_authorisation',
  'run',
  'test_case',
  'tool_call',
  'egress_request',
  'finding',
  'report',
  'export',
  'secret_ref',
  'config',
  'connector',
  'session',
  'platform',
  'assessment_request',
  // input manifests (SCOPE-006): appended, the uploads' audit target
  'input_manifest',
  'service_account',
  // virtual model keys (GATEWAY-002): appended, the target of vkey.minted and vkey.revoked
  'virtual_key',
]);
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;

export const auditTargetSchema = z.strictObject({
  type: auditTargetTypeSchema,
  id: auditIdentifierSchema,
  publicId: publicIdSchema.optional(),
});
export type AuditTarget = z.infer<typeof auditTargetSchema>;

export const auditOutcomeSchema = z.enum(['success', 'failure', 'denied']);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/** Any JSON value (I-JSON: finite numbers only). */
export type AuditJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditJsonValue[]
  | { readonly [key: string]: AuditJsonValue };

export const auditJsonValueSchema: z.ZodType<AuditJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(auditJsonValueSchema),
    z.record(z.string(), auditJsonValueSchema),
  ]),
);

/** Redacted, producer-supplied context. The size cap is checked on the whole event (see below). */
export const auditMetadataSchema = z.record(z.string(), auditJsonValueSchema);
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

/** Where metadata that exceeded the inline cap was stored. */
export const auditMetadataRefSchema = z.strictObject({
  /** Evidence-store object key (tenant-prefixed S3/MinIO key). */
  evidenceKey: z
    .string()
    .regex(/^[\x21-\x7e]{1,1024}$/, 'must be 1-1024 printable ASCII characters without spaces'),
  /** SHA-256 of the canonical JSON of the full metadata. */
  sha256: sha256HexSchema,
  /** UTF-8 size of the full canonical metadata; only refs above the inline cap exist. */
  sizeBytes: z
    .int()
    .min(AUDIT_METADATA_MAX_BYTES + 1)
    .max(AUDIT_SEQ_MAX),
});
export type AuditMetadataRef = z.infer<typeof auditMetadataRefSchema>;

/**
 * The structural shape of an event, without the NFC and size rules. This is what the JSON Schema
 * artifact describes (`schemas/audit-event.schema.json`); use {@link AuditEventSchema} to validate.
 */
export const auditEventShapeSchema = z.strictObject({
  id: uuidV7Schema,
  tenantId: lowercaseUuidSchema,
  occurredAt: isoDateTimeSchema,
  action: auditActionSchema,
  severity: auditSeveritySchema,
  actor: auditActorSchema,
  target: auditTargetSchema,
  outcome: auditOutcomeSchema,
  reason: z.string().min(1).max(LIMITS.reasonMax).optional(),
  metadata: auditMetadataSchema,
  metadataRef: auditMetadataRefSchema.optional(),
  /** W3C trace-context trace id. */
  traceId: z
    .string()
    .regex(/^(?!0{32})[0-9a-f]{32}$/, 'must be a W3C trace id')
    .optional(),
  runId: uuidV7Schema.optional(),
  ip: z.union([z.ipv4(), z.ipv6()]).optional(),
  userAgent: z.string().min(1).max(USER_AGENT_MAX).optional(),
  prevHash: sha256HexSchema,
  hash: sha256HexSchema,
  seq: z.int().min(1).max(AUDIT_SEQ_MAX),
});

type ShapeOutput = z.infer<typeof auditEventShapeSchema>;

/** Fields covered by `hash`: everything but `hash` itself. */
export type AuditEventHashed = Omit<ShapeOutput, 'hash'>;

/** NFC-normalises every string (values and keys) in a JSON-like value. */
function normaliseNfc(value: unknown, ctx: z.RefinementCtx, path: readonly PropertyKey[]): unknown {
  if (typeof value === 'string') {
    return isWellFormedString(value) ? value.normalize('NFC') : value;
  }
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item, index) =>
      normaliseNfc(item, ctx, [...path, index]),
    );
  }
  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalisedKey = isWellFormedString(key) ? key.normalize('NFC') : key;
      if (normalisedKey === '__proto__') {
        // JavaScript object handling (Zod records included) silently drops this key, so TypeScript
        // and Go would hash different metadata. Reject it instead of losing it.
        ctx.addIssue({ code: 'custom', path: [...path, key], message: 'reserved key __proto__' });
      }
      if (Object.hasOwn(output, normalisedKey)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, key],
          message: 'two keys are equal after NFC normalisation',
        });
      }
      // defineProperty, not assignment: a `__proto__` key must stay a plain member.
      Object.defineProperty(output, normalisedKey, {
        value: normaliseNfc(item, ctx, [...path, key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  }
  return value;
}

function checkEvent(event: ShapeOutput, ctx: z.RefinementCtx): void {
  const entry = auditActionEntry(event.action);
  if (AUDIT_SEVERITY_RANK[event.severity] < AUDIT_SEVERITY_RANK[entry.defaultSeverity]) {
    ctx.addIssue({
      code: 'custom',
      path: ['severity'],
      message: `must be at least ${entry.defaultSeverity} for ${event.action}`,
    });
  }
  let metadataJson: string | undefined;
  try {
    // Also proves the whole event is I-JSON (no lone surrogates), so it can be hashed.
    canonicalJson(event);
    metadataJson = canonicalJson(event.metadata);
  } catch (error) {
    if (!(error instanceof CanonicalJsonError)) {
      throw error;
    }
    ctx.addIssue({ code: 'custom', path: [], message: error.message });
  }
  if (metadataJson !== undefined && utf8ByteLength(metadataJson) > AUDIT_METADATA_MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['metadata'],
      message: `metadata exceeds ${String(AUDIT_METADATA_MAX_BYTES)} bytes; store it by reference (metadataRef)`,
    });
  }
}

/**
 * Validates an audit event: the structural shape, plus NFC normalisation, the metadata size cap, the
 * severity floor and I-JSON well-formedness. A missing `tenantId` or an unknown `action` is invalid
 * (fail closed).
 */
export const AuditEventSchema = z.preprocess(
  (value, ctx) => normaliseNfc(value, ctx, []),
  auditEventShapeSchema.superRefine(checkEvent),
);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** The hashed subset of an event: every field but `hash`, absent optionals omitted. */
export function auditEventHashedSubset(event: AuditEvent | AuditEventHashed): AuditEventHashed {
  const subset: Partial<AuditEvent> = { ...event };
  delete subset.hash;
  return subset as AuditEventHashed;
}

/**
 * The exact text whose SHA-256 is the event's `hash`: JCS (RFC 8785) over every field except `hash`.
 * Producers in other languages (the Go egress gateway) must reproduce it byte for byte; the shared
 * vectors are in `test-vectors/audit-event-hash.json`.
 */
export function auditEventHashInput(event: AuditEvent | AuditEventHashed): string {
  return canonicalJson(auditEventHashedSubset(event));
}

/** Whether a metadata object fits inline, and its canonical size, so producers know when to spill it. */
export function measureAuditMetadata(metadata: AuditMetadata): {
  readonly sizeBytes: number;
  readonly fitsInline: boolean;
} {
  const sizeBytes = utf8ByteLength(canonicalJson(metadata));
  return { sizeBytes, fitsInline: sizeBytes <= AUDIT_METADATA_MAX_BYTES };
}
