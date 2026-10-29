// Tenant-scoped evidence items and the binding of an evidence chain to a finding occurrence (EVIDENCE, #724,
// CONTEXT_PACK §7, §8.6, §8.8). Every method runs through `withTenant`, so RLS confines it and a missing tenant
// context fails closed. Items are write-once: this class appends and reads them, and never changes one.

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  EVIDENCE_OBJECT_BYTES_MAX,
  type EvidenceChainRef,
  evidenceKindSchema,
  evidenceRefSchema,
  evidenceRoleSchema,
  LIMITS,
  sha256HexSchema,
  uuidV7Schema,
} from '@blackwing/contracts';
import { evidenceChainLink } from '@blackwing/crypto';
import {
  ConflictError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { ConcurrencyError } from './repository.js';
import { toTenantIsolationError } from './rls.js';
import { evidenceItems } from './schema/evidence.js';
import { findingOccurrences, findings } from './schema/findings.js';
import { currentTenantId } from './tenant-context.js';
import { unwrapQueryError, type TenantTx, withTenant } from './with-tenant.js';

import type { Database } from './client.js';

/** One row of `evidence_items`. */
export type EvidenceItemRow = typeof evidenceItems.$inferSelect;
/** One row of `finding_occurrences`, as the binding reads it. */
export interface OccurrenceForBinding {
  readonly id: string;
  readonly findingId: string;
  readonly evidenceRefs: readonly EvidenceChainRef[];
}
/** A finding as the binding reads it: its status and the optimistic-concurrency version. */
export interface FindingForBinding {
  readonly id: string;
  readonly status: string;
  readonly stateVersion: number;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const AWAITING_VALIDATION: readonly string[] = ['candidate', 'validating'];

const appendSchema = z.strictObject({
  runId: uuidV7Schema,
  kind: evidenceKindSchema,
  role: evidenceRoleSchema,
  objectKey: evidenceRefSchema,
  sha256: sha256HexSchema,
  size: z.int().min(0).max(EVIDENCE_OBJECT_BYTES_MAX),
  contentType: z
    .string()
    .transform((value) => value.normalize('NFC'))
    .pipe(z.string().min(1).max(LIMITS.shortTextMax)),
  capturedAt: z.date(),
  retentionUntil: z.date().nullish(),
  legalHold: z.boolean().default(false),
});

const idsSchema = z.array(uuidV7Schema).min(1).max(LIMITS.shortTextMax);

const bindSchema = z.strictObject({
  findingId: uuidV7Schema,
  occurrenceId: uuidV7Schema,
  expectedStateVersion: z.int().min(0),
  refs: z
    .array(
      z.strictObject({
        evidenceId: uuidV7Schema,
        objectKey: evidenceRefSchema,
        sha256: sha256HexSchema,
        chain: sha256HexSchema,
      }),
    )
    .min(1),
});

const markSuspectedSchema = z.strictObject({
  findingId: uuidV7Schema,
  occurrenceId: uuidV7Schema,
  expectedStateVersion: z.int().min(0),
});

export interface EvidenceRepositoryOptions {
  readonly db: Database;
  /** Ambient tenant source; defaults to the AsyncLocalStorage context. Tests and tools pass one. */
  readonly tenant?: () => string | undefined;
}

/** Input of {@link EvidenceRepository.append}. The chain link and sequence are computed here, never by the caller. */
export type AppendEvidenceInput = z.input<typeof appendSchema>;

/**
 * Tenant-scoped evidence persistence. `append` extends the run's stream under an advisory lock, so two appends for
 * one run cannot fork the chain. `getMany` and the binding methods read and write through RLS as well.
 */
export class EvidenceRepository {
  constructor(private readonly options: EvidenceRepositoryOptions) {}

  /** Appends one item to the run's stream: next sequence, link to the previous item, then insert. Write-once. */
  async append(input: AppendEvidenceInput): Promise<EvidenceItemRow> {
    const values = parse(appendSchema, input, 'evidence item');
    const id = newId();
    return this.run(async (tx, tenantId) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${values.runId}::text, 0))`,
      );
      const [last] = await tx
        .select({ sequence: evidenceItems.sequence, chain: evidenceItems.chain })
        .from(evidenceItems)
        .where(and(eq(evidenceItems.tenantId, tenantId), eq(evidenceItems.runId, values.runId)))
        .orderBy(desc(evidenceItems.sequence))
        .limit(1);
      const prevChain = last?.chain ?? null;
      const [inserted] = await tx
        .insert(evidenceItems)
        .values({
          id,
          tenantId,
          runId: values.runId,
          sequence: (last?.sequence ?? 0) + 1,
          kind: values.kind,
          role: values.role,
          objectKey: values.objectKey,
          sha256: values.sha256,
          size: values.size,
          contentType: values.contentType,
          capturedAt: values.capturedAt,
          prevChain,
          chain: evidenceChainLink({
            prevChain,
            sha256: values.sha256,
            kind: values.kind,
            role: values.role,
            size: values.size,
            objectKey: values.objectKey,
          }),
          retentionUntil: values.retentionUntil ?? null,
          legalHold: values.legalHold,
        })
        .returning();
      if (inserted === undefined) throw new Error('evidence insert returned no row');
      return inserted;
    }, 'append');
  }

  /** The items with these ids, in the stream order they were appended. Unknown and foreign ids are simply absent. */
  async getMany(ids: readonly string[]): Promise<EvidenceItemRow[]> {
    const rowIds = parse(idsSchema, ids, 'evidence ids');
    return this.run(async (tx, tenantId) => {
      const rows = await tx
        .select()
        .from(evidenceItems)
        .where(and(eq(evidenceItems.tenantId, tenantId), inArray(evidenceItems.id, rowIds)))
        .orderBy(asc(evidenceItems.runId), asc(evidenceItems.sequence));
      return rows;
    }, 'getMany');
  }

  /** The finding and the occurrence named by the binding, or `undefined` when either is unknown or foreign. */
  async getFindingForBinding(
    findingId: string,
    occurrenceId: string,
  ): Promise<{ finding: FindingForBinding; occurrence: OccurrenceForBinding } | undefined> {
    const ids = parse(
      z.strictObject({ findingId: uuidV7Schema, occurrenceId: uuidV7Schema }),
      {
        findingId,
        occurrenceId,
      },
      'binding ids',
    );
    return this.run(async (tx, tenantId) => {
      const [row] = await tx
        .select({
          findingId: findings.id,
          status: findings.status,
          stateVersion: findings.stateVersion,
          occurrenceId: findingOccurrences.id,
          evidenceRefs: findingOccurrences.evidenceRefs,
        })
        .from(findings)
        .innerJoin(
          findingOccurrences,
          and(
            eq(findingOccurrences.findingId, findings.id),
            eq(findingOccurrences.tenantId, findings.tenantId),
          ),
        )
        .where(
          and(
            eq(findings.tenantId, tenantId),
            eq(findings.id, ids.findingId),
            eq(findingOccurrences.id, ids.occurrenceId),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      return {
        finding: { id: row.findingId, status: row.status, stateVersion: row.stateVersion },
        occurrence: {
          id: row.occurrenceId,
          findingId: row.findingId,
          evidenceRefs: row.evidenceRefs,
        },
      };
    }, 'getFindingForBinding');
  }

  /**
   * Records the ordered chain on the occurrence and confirms the finding, in one transaction. Idempotent: an
   * occurrence already bound to the same chain is left as it is; a different chain is a conflict. The finding must
   * still be awaiting validation at `expectedStateVersion`, or the write is refused (`ConcurrencyError`).
   */
  async bindChain(input: unknown): Promise<'bound' | 'already_bound'> {
    const values = parse(bindSchema, input, 'evidence binding');
    return this.run(async (tx, tenantId) => {
      const occurrence = await lockOccurrence(tx, tenantId, values.findingId, values.occurrenceId);
      const bound = occurrence.evidenceRefs;
      if (bound.length > 0) {
        if (sameChain(bound, values.refs)) return 'already_bound';
        throw new ConflictError('this occurrence already has a different evidence chain');
      }
      await lockFinding(tx, tenantId, values.findingId, values.expectedStateVersion);
      const head = values.refs.at(-1)?.chain ?? null;
      await tx
        .update(findingOccurrences)
        .set({
          evidenceRefs: [...values.refs],
          evidenceChainHead: head,
          occurrenceStatus: 'confirmed',
        })
        .where(eq(findingOccurrences.id, values.occurrenceId));
      await tx
        .update(findings)
        .set({ status: 'confirmed', stateVersion: sql`${findings.stateVersion} + 1` })
        .where(
          and(
            eq(findings.tenantId, tenantId),
            eq(findings.id, values.findingId),
            eq(findings.stateVersion, values.expectedStateVersion),
          ),
        );
      return 'bound';
    }, 'bindChain');
  }

  /**
   * Marks the finding and its occurrence Suspected after an integrity failure (§8.8). Nothing is bound. The same
   * optimistic check as `bindChain` applies, so a concurrent change is refused rather than overwritten.
   */
  async markSuspected(input: unknown): Promise<void> {
    const values = parse(markSuspectedSchema, input, 'suspected marking');
    await this.run(async (tx, tenantId) => {
      const occurrence = await lockOccurrence(tx, tenantId, values.findingId, values.occurrenceId);
      if (occurrence.evidenceRefs.length > 0) {
        throw new ConflictError('a bound occurrence cannot be marked suspected');
      }
      await lockFinding(tx, tenantId, values.findingId, values.expectedStateVersion);
      await tx
        .update(findingOccurrences)
        .set({ occurrenceStatus: 'suspected' })
        .where(eq(findingOccurrences.id, values.occurrenceId));
      await tx
        .update(findings)
        .set({ status: 'suspected', stateVersion: sql`${findings.stateVersion} + 1` })
        .where(
          and(
            eq(findings.tenantId, tenantId),
            eq(findings.id, values.findingId),
            eq(findings.stateVersion, values.expectedStateVersion),
          ),
        );
    }, 'markSuspected');
  }

  /** Runs `fn` in the ambient tenant's transaction and translates database errors to the typed set. */
  private async run<R>(fn: (tx: TenantTx, tenantId: string) => Promise<R>, op: string): Promise<R> {
    const tenantId = this.tenantId();
    try {
      return await withTenant(this.options.db, tenantId, (tx) => fn(tx, tenantId));
    } catch (error) {
      throw translate(error, op);
    }
  }

  private tenantId(): string {
    const tenantId = (this.options.tenant ?? currentTenantId)();
    if (tenantId === undefined || tenantId === '') {
      throw new TenantContextMissingError('no tenant context: refusing to run an evidence query');
    }
    return tenantId;
  }
}

/** Locks the occurrence row of a finding (the first lock in every binding transaction). */
async function lockOccurrence(
  tx: TenantTx,
  tenantId: string,
  findingId: string,
  occurrenceId: string,
): Promise<OccurrenceForBinding> {
  const [row] = await tx
    .select({ id: findingOccurrences.id, evidenceRefs: findingOccurrences.evidenceRefs })
    .from(findingOccurrences)
    .where(
      and(
        eq(findingOccurrences.tenantId, tenantId),
        eq(findingOccurrences.id, occurrenceId),
        eq(findingOccurrences.findingId, findingId),
      ),
    )
    .for('update')
    .limit(1);
  if (row === undefined) throw new NotFoundError('finding occurrence not found');
  return { id: row.id, findingId, evidenceRefs: row.evidenceRefs };
}

/** Locks the finding, then checks it is still awaiting validation at the expected version. */
async function lockFinding(
  tx: TenantTx,
  tenantId: string,
  findingId: string,
  expectedStateVersion: number,
): Promise<void> {
  const [row] = await tx
    .select({ status: findings.status, stateVersion: findings.stateVersion })
    .from(findings)
    .where(and(eq(findings.tenantId, tenantId), eq(findings.id, findingId)))
    .for('update')
    .limit(1);
  if (row === undefined) throw new NotFoundError('finding not found');
  if (row.stateVersion !== expectedStateVersion) throw new ConcurrencyError('finding');
  if (!AWAITING_VALIDATION.includes(row.status)) {
    throw new ConflictError('finding is not awaiting validation');
  }
}

/** True when two chains name the same evidence in the same order with the same digests and links. */
function sameChain(a: readonly EvidenceChainRef[], b: readonly EvidenceChainRef[]): boolean {
  return (
    a.length === b.length &&
    a.every((ref, index) => {
      const other = b[index];
      return (
        ref.evidenceId === other?.evidenceId &&
        ref.sha256 === other.sha256 &&
        ref.chain === other.chain
      );
    })
  );
}

function parse<V>(schema: z.ZodType<V>, value: unknown, what: string): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Field paths only: issue messages can echo input values.
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError(`invalid ${what}`, {
      detail: `Invalid ${what}: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return result.data;
}

/** Maps a Postgres error to the typed set: a duplicate is a conflict, a CHECK violation is a client error. */
function translate(error: unknown, op: string): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown };
  if (pgError.code === UNIQUE_VIOLATION) {
    return new ConflictError(`evidence ${op}: a conflicting row already exists`, { cause: error });
  }
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid evidence', {
      detail: 'A database check rejected the evidence.',
      cause: error,
    });
  }
  return toTenantIsolationError(pgError) ?? error;
}
