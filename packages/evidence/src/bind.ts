// Binding a replay's evidence to a validated finding (#724, EVIDENCE, CONTEXT_PACK §3.4, §8.6, §8.7, §8.8). A
// Confirmed finding is only ever produced here: the minimum evidence set is checked, the chain and every digest are
// verified against the stored bytes, and only then is the ordered chain written to the occurrence and the finding
// confirmed, in one transaction. Any failed integrity check moves the finding to Suspected instead.

import {
  bindEvidenceInputSchema,
  EVIDENCE_OBJECT_BYTES_MAX,
  type EvidenceChainRef,
} from '@blackwing/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';

import { verifyEvidenceChain } from './chain.js';
import { EvidenceIntegrityError, type EvidenceIntegrityReason } from './errors.js';
import { assertMinimumEvidenceSet } from './minimum.js';
import { type EvidenceMetrics, log, noopEvidenceMetrics, tracer } from './telemetry.js';

import type { EvidenceObjectReader } from './objects.js';
import type { EvidenceItemRow, FindingForBinding, OccurrenceForBinding } from '@blackwing/db';
import type { Span } from '@opentelemetry/api';

/** The evidence fields binding reads. Structurally satisfied by an `evidence_items` row. */
export type EvidenceRecord = Pick<
  EvidenceItemRow,
  'id' | 'kind' | 'role' | 'objectKey' | 'sha256' | 'size' | 'prevChain' | 'chain'
>;

/** The storage port: the tenant-scoped repository in `@blackwing/db` implements it. */
export interface EvidenceBindingStore {
  readonly getFindingForBinding: (
    findingId: string,
    occurrenceId: string,
  ) => Promise<{ finding: FindingForBinding; occurrence: OccurrenceForBinding } | undefined>;
  readonly getMany: (ids: readonly string[]) => Promise<readonly EvidenceRecord[]>;
  readonly bindChain: (input: {
    readonly findingId: string;
    readonly occurrenceId: string;
    readonly expectedStateVersion: number;
    readonly refs: readonly EvidenceChainRef[];
  }) => Promise<'bound' | 'already_bound'>;
  readonly markSuspected: (input: {
    readonly findingId: string;
    readonly occurrenceId: string;
    readonly expectedStateVersion: number;
  }) => Promise<void>;
}

/** Audit events this module emits (`evidence.bound`, `evidence.integrity_failed`). */
export type EvidenceAuditEvent =
  | { readonly type: 'evidence.bound'; readonly findingId: string; readonly count: number }
  | {
      readonly type: 'evidence.integrity_failed';
      readonly findingId: string;
      readonly reason: EvidenceIntegrityReason;
    };

export interface EvidenceAudit {
  readonly record: (event: EvidenceAuditEvent) => Promise<void>;
}

export interface BindEvidenceDeps {
  readonly store: EvidenceBindingStore;
  readonly objects: EvidenceObjectReader;
  readonly audit: EvidenceAudit;
  readonly metrics?: EvidenceMetrics;
  /** Largest item the binding will read (the contract's object cap by default). */
  readonly maxItemBytes?: number;
}

export interface BindEvidenceResult {
  readonly outcome: 'confirmed';
  /** True when the occurrence already held this exact chain, so nothing was written. */
  readonly alreadyBound: boolean;
  readonly chain: readonly EvidenceChainRef[];
}

/**
 * Binds `evidenceIds`, in order, to the occurrence of `findingId` and confirms the finding. Throws:
 * - `ValidationError` for a malformed input, a duplicate id, an unknown or foreign id, an oversized item, or an
 *   incomplete minimum evidence set. The finding is left as it was: an incomplete set is not an integrity failure;
 * - `EvidenceIntegrityError` for a broken chain, a digest that does not match, or unreadable bytes. The finding is
 *   moved to Suspected first, and the audit trail records the reason;
 * - `NotFoundError` / `ConflictError` from the store for an unknown occurrence or a different chain already bound.
 */
export async function bindEvidence(
  deps: BindEvidenceDeps,
  raw: unknown,
): Promise<BindEvidenceResult> {
  const parsed = bindEvidenceInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError('invalid evidence binding', {
      detail: `Invalid evidence binding: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  const input = parsed.data;
  if (new Set(input.evidenceIds).size !== input.evidenceIds.length) {
    throw new ValidationError('evidence binding names the same item twice');
  }
  return tracer.startActiveSpan('validation.bind_evidence', async (span) => {
    span.setAttributes({ findingId: input.findingId, evidenceCount: input.evidenceIds.length });
    try {
      return await bindChecked(deps, input, span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error('bind failed'));
      throw error;
    } finally {
      span.end();
    }
  });
}

async function bindChecked(
  deps: BindEvidenceDeps,
  input: { findingId: string; occurrenceId: string; evidenceIds: string[]; oracleType: string },
  span: Span,
): Promise<BindEvidenceResult> {
  const { findingId, occurrenceId, evidenceIds, oracleType } = input;
  const found = await deps.store.getFindingForBinding(findingId, occurrenceId);
  if (found === undefined) throw new NotFoundError('finding occurrence not found');

  // Idempotent: the same chain again is a no-op. A different chain on a bound occurrence is refused.
  const bound = found.occurrence.evidenceRefs;
  if (bound.length > 0) {
    const sameIds =
      bound.length === evidenceIds.length &&
      bound.every((ref, index) => ref.evidenceId === evidenceIds[index]);
    if (!sameIds) throw new ConflictError('this occurrence already has a different evidence chain');
    return { outcome: 'confirmed', alreadyBound: true, chain: bound };
  }

  // Ids the tenant cannot see (missing, or another tenant's) are simply absent from the result.
  const items = await deps.store.getMany(evidenceIds);
  const byId = new Map(items.map((item) => [item.id, item]));
  const records: EvidenceRecord[] = [];
  for (const id of evidenceIds) {
    const item = byId.get(id);
    if (item === undefined) throw new ValidationError('evidence reference is not available');
    records.push(item);
  }
  span.setAttribute('evidenceCountFound', records.length);

  const maxBytes = deps.maxItemBytes ?? EVIDENCE_OBJECT_BYTES_MAX;
  if (records.some((item) => item.size > maxBytes)) {
    throw new ValidationError('evidence item exceeds the size limit');
  }
  // A missing minimum set is refused without touching the finding: it is incomplete, not tampered.
  assertMinimumEvidenceSet(oracleType, records);

  const expectedStateVersion = found.finding.stateVersion;
  const chain = verifyEvidenceChain(records);
  if (!chain.ok) return fail(deps, findingId, occurrenceId, expectedStateVersion, 'chain_broken');

  for (const item of records) {
    const reason = await digestMismatch(deps.objects, item);
    if (reason !== undefined) {
      return fail(deps, findingId, occurrenceId, expectedStateVersion, reason);
    }
  }

  const refs: EvidenceChainRef[] = records.map((item) => ({
    evidenceId: item.id,
    objectKey: item.objectKey,
    sha256: item.sha256,
    chain: item.chain,
  }));
  const outcome = await deps.store.bindChain({
    findingId,
    occurrenceId,
    expectedStateVersion,
    refs,
  });
  if (outcome === 'bound') {
    await deps.audit.record({ type: 'evidence.bound', findingId, count: refs.length });
    (deps.metrics ?? noopEvidenceMetrics).bound();
  }
  return { outcome: 'confirmed', alreadyBound: outcome === 'already_bound', chain: refs };
}

/** Re-hashes one item's bytes. Returns the failure reason, or undefined when the digest matches. */
async function digestMismatch(
  objects: EvidenceObjectReader,
  item: EvidenceRecord,
): Promise<EvidenceIntegrityReason | undefined> {
  let actual: string;
  try {
    actual = await objects.sha256Of(item.objectKey);
  } catch {
    // Unreadable is unverifiable, so it fails closed. The error text is dropped: it can carry storage detail.
    return 'object_unreadable';
  }
  return actual === item.sha256 ? undefined : 'sha256_mismatch';
}

/** Moves the finding and occurrence to Suspected, audits and counts the failure, then throws the integrity error. */
async function fail(
  deps: BindEvidenceDeps,
  findingId: string,
  occurrenceId: string,
  expectedStateVersion: number,
  reason: EvidenceIntegrityReason,
): Promise<never> {
  await deps.store.markSuspected({ findingId, occurrenceId, expectedStateVersion });
  await deps.audit.record({ type: 'evidence.integrity_failed', findingId, reason });
  (deps.metrics ?? noopEvidenceMetrics).integrityFailed();
  log.warn({ reason }, 'evidence integrity check failed; finding suspected');
  throw new EvidenceIntegrityError(reason);
}
