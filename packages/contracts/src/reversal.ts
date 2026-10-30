import { z } from 'zod';

import { LIMITS } from './limits.js';
import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';
import { nfcTextSchema } from './validation/oracle.js';

/**
 * Reversal journal contracts (REVERSAL-001, F20, CONTEXT_PACK §3.5, §7, §8.3). Every `state_changing` action is
 * journalled before it runs, with a typed, reversible undo descriptor. REVERSAL-005 executes the undo from this
 * descriptor deterministically, so an undo is data, never a shell command or free-form payload.
 *
 * Inline JSON (`target`, `undo_instructions`) is capped at {@link REVERSAL_INLINE_MAX_BYTES}. Anything larger is
 * stored as evidence and referenced with `{ evidenceId }`, so a secret or a bulky payload never lands in the row.
 */

/** Size cap of one inline JSON payload (16 KiB). The CHECK constraints in the database enforce the same bound. */
const BYTES_PER_KIB = 1024;
const INLINE_CEILING_KIB = 16;
export const REVERSAL_INLINE_MAX_BYTES = INLINE_CEILING_KIB * BYTES_PER_KIB;

/** Undo lifecycle (CONTEXT_PACK §7): `pending` until REVERSAL-005 acts, then one of the other three. */
export const REVERSAL_UNDO_STATUSES = ['pending', 'undone', 'not_needed', 'failed'] as const;
export type ReversalUndoStatus = (typeof REVERSAL_UNDO_STATUSES)[number];
export const reversalUndoStatusSchema = z.enum(REVERSAL_UNDO_STATUSES);

/** The only intrusiveness class the journal records: a journal entry is the precondition for `state_changing` (§8.3). */
export const REVERSAL_INTRUSIVENESS_CLASS = 'state_changing' as const;

/** How the journalled action touches its target. */
export const REVERSAL_TARGET_KINDS = ['endpoint', 'record', 'resource'] as const;
export const reversalTargetKindSchema = z.enum(REVERSAL_TARGET_KINDS);

/** HTTP methods a journalled endpoint target may use. */
export const REVERSAL_HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Reversible undo actions. REVERSAL-005 interprets each one; there is no other action type. */
export const REVERSAL_UNDO_TYPES = [
  'http_request',
  'restore_field',
  'delete_created_resource',
] as const;
export type ReversalUndoType = (typeof REVERSAL_UNDO_TYPES)[number];
export const reversalUndoTypeSchema = z.enum(REVERSAL_UNDO_TYPES);

const REF_MAX = 512;
const URL_TEMPLATE_MAX = 2048;
const PARAM_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const PARAM_MAX_KEYS = 32;

/** The target the action touches: a reference (`ref`), never a credential or a secret value. */
export const reversalTargetSchema = z
  .strictObject({
    kind: reversalTargetKindSchema,
    ref: nfcTextSchema(REF_MAX),
    method: z.enum(REVERSAL_HTTP_METHODS).optional(),
    urlTemplate: nfcTextSchema(URL_TEMPLATE_MAX).optional(),
  })
  .superRefine((target, ctx) => {
    if (target.method !== undefined && target.kind !== 'endpoint') {
      ctx.addIssue({
        code: 'custom',
        path: ['method'],
        message: 'method applies to endpoint targets only',
      });
    }
  });
export type ReversalTarget = z.infer<typeof reversalTargetSchema>;

/** A scalar parameter value. Nested objects and arrays are refused, so the descriptor stays flat. */
const paramValueSchema = z.union([
  z.string().max(LIMITS.labelMax),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * The typed undo descriptor: an action `type` from {@link REVERSAL_UNDO_TYPES} and flat, strict `params`. Unknown
 * keys (for example `command` or `shell`) are refused, so the only executable undo is one of the declared types.
 */
export const reversalUndoDescriptorSchema = z.strictObject({
  type: reversalUndoTypeSchema,
  params: z
    .record(z.string().regex(PARAM_KEY, 'invalid parameter name'), paramValueSchema)
    .refine((params) => Object.keys(params).length <= PARAM_MAX_KEYS, {
      message: `at most ${PARAM_MAX_KEYS} parameters`,
    }),
});
export type ReversalUndoDescriptor = z.infer<typeof reversalUndoDescriptorSchema>;

/** A reference to evidence that holds an undo or target payload too large to store inline. */
export const reversalEvidenceRefSchema = z.strictObject({ evidenceId: uuidV7Schema });
export type ReversalEvidenceRef = z.infer<typeof reversalEvidenceRefSchema>;

/** Serialised UTF-8 byte length of a JSON value (the same measure the database CHECK uses on its text form). */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function withinInlineCap<S extends z.ZodType>(schema: S): S {
  return schema.refine((value) => jsonByteLength(value) <= REVERSAL_INLINE_MAX_BYTES, {
    message: `inline payload exceeds ${REVERSAL_INLINE_MAX_BYTES} bytes; store it as evidence`,
  });
}

/** `target` as stored: an inline target within the 16 KiB cap. */
export const reversalTargetPayloadSchema = withinInlineCap(reversalTargetSchema);

/** `undo_instructions` as stored: an inline typed descriptor, or an evidence reference for an oversized one. */
export const reversalUndoPayloadSchema = z.union([
  withinInlineCap(reversalUndoDescriptorSchema),
  reversalEvidenceRefSchema,
]);
export type ReversalUndoPayload = z.infer<typeof reversalUndoPayloadSchema>;

/** Public id of an entry: `rvj_` plus 26 lowercase Crockford base32 characters (`publicId('rvj', id)`). */
export const reversalJournalPublicIdSchema = z
  .string()
  .regex(/^rvj_[0-9a-hjkmnp-tv-z]{26}$/, 'invalid rvj public id');

/** A stored journal entry as the API and the domain see it. */
export const reversalJournalEntrySchema = z.strictObject({
  id: uuidV7Schema,
  publicId: reversalJournalPublicIdSchema,
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  testCaseId: uuidV7Schema,
  subtaskId: uuidV7Schema.nullable(),
  action: nfcTextSchema(LIMITS.labelMax),
  target: reversalTargetPayloadSchema,
  intrusivenessClass: z.literal(REVERSAL_INTRUSIVENESS_CLASS),
  undoInstructions: reversalUndoPayloadSchema,
  undoStatus: reversalUndoStatusSchema,
  undoAttempts: z.number().int().min(0),
  undoneAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ReversalJournalEntryContract = z.infer<typeof reversalJournalEntrySchema>;

/**
 * What a writer supplies to journal an action before it runs (REVERSAL-002). The id, public id, status and
 * timestamps are assigned by the repository. The intrusiveness class is fixed, so a non-`state_changing` entry is
 * unrepresentable.
 */
export const reversalJournalCreateSchema = z.strictObject({
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  testCaseId: uuidV7Schema,
  subtaskId: uuidV7Schema.nullable().optional(),
  action: nfcTextSchema(LIMITS.labelMax),
  target: reversalTargetPayloadSchema,
  undoInstructions: reversalUndoPayloadSchema,
});
export type ReversalJournalCreate = z.input<typeof reversalJournalCreateSchema>;
export type ReversalJournalCreateParsed = z.output<typeof reversalJournalCreateSchema>;
