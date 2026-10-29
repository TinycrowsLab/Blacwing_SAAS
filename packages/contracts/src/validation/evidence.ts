import { z } from 'zod';

import { sha256HexSchema, uuidV7Schema } from '../primitives.js';
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
