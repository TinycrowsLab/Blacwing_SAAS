import { z } from 'zod';

import {
  checkTimestamps,
  isoDateTimeSchema,
  sha256HexSchema,
  uuidV7Schema,
} from '../primitives.js';
import { evidenceRefSchema, oracleBindingTypeSchema } from './oracle.js';

/**
 * Evidence item vocabulary and the binding of evidence to a validated finding (EVIDENCE, CONTEXT_PACK §7, §8.7,
 * §8.8). Evidence is stored as references: an object key plus its SHA-256 and its chain link, never the bytes.
 */

/** Kinds of evidence an item can hold (CONTEXT_PACK §7 `evidence_items.kind`). Additive only. */
export const EVIDENCE_KINDS = [
  'request',
  'response',
  'har',
  'pcap',
  'screenshot',
  'dom',
  'replay_script',
  'oob_interaction',
  'transcript_excerpt',
  'log',
] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/**
 * Which part of a replay an item belongs to. The minimum evidence set of a Confirmed finding is keyed on this:
 * the positive control, the negative control, and the oracle's own observation (for example an OOB interaction).
 */
export const EVIDENCE_ROLES = ['positive', 'negative_control', 'oracle'] as const;
export const evidenceRoleSchema = z.enum(EVIDENCE_ROLES);
export type EvidenceRole = z.infer<typeof evidenceRoleSchema>;

/** The largest single evidence object (5 GiB). Larger items are refused; the broker registers no more than this. */
export const EVIDENCE_OBJECT_BYTES_MAX = 5_368_709_120;
/** Most evidence items one binding may name. */
export const MAX_BOUND_EVIDENCE = 64;

/** One link of a finding occurrence's bound chain, in order. References only: no body, no secret value. */
export const evidenceChainRefSchema = z.strictObject({
  evidenceId: uuidV7Schema,
  objectKey: evidenceRefSchema,
  sha256: sha256HexSchema,
  chain: sha256HexSchema,
});
export type EvidenceChainRef = z.infer<typeof evidenceChainRefSchema>;

/** Input of `bindEvidence`: the finding and occurrence, the ordered evidence ids and the oracle the replay used. */
export const bindEvidenceInputSchema = z.strictObject({
  findingId: uuidV7Schema,
  occurrenceId: uuidV7Schema,
  evidenceIds: z.array(uuidV7Schema).min(1).max(MAX_BOUND_EVIDENCE),
  oracleType: oracleBindingTypeSchema,
});
export type BindEvidenceInput = z.infer<typeof bindEvidenceInputSchema>;

/**
 * Public ids of the two evidence tables: the prefix plus a 26-character lowercase Crockford base32 body (the
 * `@blackwing/ids` form, which excludes i, l, o and u).
 */
const CONTENT_TYPE_MAX = 127;
/** The largest `integer` (int4) value: a stream position is stored as one. */
const SEQUENCE_MAX = 2_147_483_647;
const FORMAT_VERSION_MAX = 32;

/** Lowercase `evd_`/`rpa_` public-id body. */
const EVIDENCE_PUBLIC_ID_BODY = '[0-9abcdefghjkmnpqrstvwxyz]{26}';
const evidencePublicIdSchema = z
  .string()
  .regex(new RegExp(`^evd_${EVIDENCE_PUBLIC_ID_BODY}$`), 'must be an evd_ public id');
const reproArtifactPublicIdSchema = z
  .string()
  .regex(new RegExp(`^rpa_${EVIDENCE_PUBLIC_ID_BODY}$`), 'must be an rpa_ public id');

/** Version of the repro bundle layout: a short token, so a reader can refuse a format it does not know. */
const reproFormatVersionSchema = z
  .string()
  .min(1)
  .max(FORMAT_VERSION_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a format version');

/** A lowercase RFC 6838 `type/subtype` media type without parameters. */
export const evidenceContentTypeSchema = z
  .string()
  .max(CONTENT_TYPE_MAX)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
    'must be a lowercase type/subtype media type',
  );

/** A byte count: a non-negative integer no larger than one evidence object. */
const evidenceSizeSchema = z.int().min(0).max(EVIDENCE_OBJECT_BYTES_MAX);

/**
 * `evidence_items` row (CONTEXT_PACK §7). Write-once: only `retentionUntil` and `legalHold` change after insert.
 * `sequence` is the position in the run's chain, from 1; `prevChain` is null for the first item only.
 */
export const evidenceItemSchema = z
  .strictObject({
    id: uuidV7Schema,
    publicId: evidencePublicIdSchema.nullable(),
    tenantId: uuidV7Schema,
    runId: uuidV7Schema,
    findingId: uuidV7Schema.nullable(),
    occurrenceId: uuidV7Schema.nullable(),
    sequence: z.int().min(1).max(SEQUENCE_MAX),
    kind: evidenceKindSchema,
    role: evidenceRoleSchema,
    objectKey: evidenceRefSchema,
    sha256: sha256HexSchema,
    size: evidenceSizeSchema,
    contentType: evidenceContentTypeSchema,
    capturedAt: isoDateTimeSchema,
    prevChain: sha256HexSchema.nullable(),
    chain: sha256HexSchema,
    retentionUntil: isoDateTimeSchema.nullable(),
    legalHold: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine(checkTimestamps);

/**
 * `repro_artifacts` row (CONTEXT_PACK §7): one reproduction bundle for a finding. The bytes live in object storage;
 * this row holds the key, the digest and the bundle format version only.
 */
export const reproArtifactSchema = z
  .strictObject({
    id: uuidV7Schema,
    publicId: reproArtifactPublicIdSchema.nullable(),
    tenantId: uuidV7Schema,
    findingId: uuidV7Schema,
    bundleKey: evidenceRefSchema,
    sha256: sha256HexSchema,
    formatVersion: reproFormatVersionSchema,
    size: evidenceSizeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine(checkTimestamps);

/** Input of creating a repro artifact. The id, public id and tenant are assigned by the writer, never the caller. */
export const reproArtifactCreateSchema = z.strictObject({
  findingId: uuidV7Schema,
  bundleKey: evidenceRefSchema,
  sha256: sha256HexSchema,
  formatVersion: reproFormatVersionSchema,
  size: evidenceSizeSchema.nullable().default(null),
});
