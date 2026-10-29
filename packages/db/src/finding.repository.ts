// Tenant-scoped persistence of findings and their per-run occurrences (FINDING-001, CONTEXT_PACK §3.4, §7,
// §8.6). Every method runs through `withTenant`, so RLS confines it and a missing tenant context fails closed.
// The lifecycle transitions, the fingerprint algorithm and the audit of release (FINDING-002/003, Gate 3) are
// owned by later issues: this class owns the rows, their validation and optimistic concurrency only.

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  baselineStatusSchema,
  cweIdSchema,
  findingLocationSchema,
  findingStatusSchema,
  LIMITS,
  sha256HexSchema,
  severitySchema,
  uuidV7Schema,
} from '@blackwing/contracts';
import {
  ConflictError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { publicId } from './columns.js';
import {
  type CursorPosition,
  ConcurrencyError,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  ForeignKeyError,
  MAX_PAGE_LIMIT,
} from './repository.js';
import { toTenantIsolationError } from './rls.js';
import {
  findingOccurrences,
  findings,
  FINDING_LOCATION_MAX_BYTES,
  FINDING_SEVERITY_MAX_BYTES,
} from './schema/findings.js';
import { currentTenantId } from './tenant-context.js';
import { unwrapQueryError, type TenantTx, withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { DbLogger } from './pool.js';

/** One row of `findings`. */
export type FindingRow = typeof findings.$inferSelect;
/** One row of `finding_occurrences`. */
export type FindingOccurrenceRow = typeof findingOccurrences.$inferSelect;

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const DUPLICATE_FINDING = 'a finding with this fingerprint already exists';
const DUPLICATE_OCCURRENCE = 'this run already recorded an occurrence of the finding';

/** NFC-normalised text of at most `max` characters (the contract's length bounds, in code points). */
function nfcText(max: number) {
  return z
    .string()
    .transform((value) => value.normalize('NFC'))
    .pipe(z.string().min(1).max(max));
}

/** Stored byte size of a jsonb value, as the database caps it (FINDING-001: oversized context is refused). */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** The location with its free-text fields NFC-normalised, so one string has one stored form. */
const locationSchema = findingLocationSchema
  .transform((location) => ({
    ...location,
    urlTemplate: location.urlTemplate?.normalize('NFC') ?? null,
    parameter: location.parameter?.normalize('NFC') ?? null,
    file: location.file?.normalize('NFC') ?? null,
  }))
  // A finding must be locatable: a URL template or a file (the rule `findingSchema` also enforces).
  .refine((location) => location.urlTemplate !== null || location.file !== null, {
    message: 'a location needs a URL template or a file',
  })
  .refine((location) => jsonBytes(location) <= FINDING_LOCATION_MAX_BYTES, {
    message: 'location is too large',
  });

const severityCapped = severitySchema.refine(
  (severity) => jsonBytes(severity) <= FINDING_SEVERITY_MAX_BYTES,
  { message: 'severity is too large' },
);

/**
 * `create` input. The tenant is never accepted: it is the ambient tenant of the call. A new finding starts as
 * `candidate` unless the caller says otherwise; the database refuses a status that needs a release or an
 * accepted-risk record (`findings_released_check`, `findings_accepted_risk_check`).
 */
const createSchema = z.strictObject({
  fingerprint: sha256HexSchema,
  title: nfcText(LIMITS.labelMax),
  class: nfcText(LIMITS.shortTextMax),
  cweId: cweIdSchema.nullish(),
  owaspCategory: nfcText(LIMITS.shortTextMax).nullish(),
  severity: severityCapped.nullish(),
  assetId: uuidV7Schema,
  location: locationSchema,
  status: findingStatusSchema.default('candidate'),
  baselineStatus: baselineStatusSchema.nullish(),
  runId: uuidV7Schema,
  firstSeenRunId: uuidV7Schema,
  lastSeenRunId: uuidV7Schema,
  confidence: z.number().min(0).max(1).nullish(),
});

/**
 * Patch of a finding's mutable fields. The release and accepted-risk records are not writable here: they are
 * set only by the triage flow (FINDING-002), which owns their checks. Empty patches are refused.
 */
const updateSchema = z
  .strictObject({
    status: findingStatusSchema.optional(),
    baselineStatus: baselineStatusSchema.nullable().optional(),
    severity: severityCapped.nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    cweId: cweIdSchema.nullable().optional(),
    owaspCategory: nfcText(LIMITS.shortTextMax).nullable().optional(),
    lastSeenRunId: uuidV7Schema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'patch is empty' });

const occurrenceCreateSchema = z.strictObject({
  findingId: uuidV7Schema,
  runId: uuidV7Schema,
  occurrenceStatus: nfcText(LIMITS.shortTextMax),
  evidenceChainHead: sha256HexSchema.nullish(),
  detectedAt: z.date(),
});

const idSchema = z.uuid();
/** `state_version` is a Postgres `integer`. */
const MAX_STATE_VERSION = 2_147_483_647;
const versionSchema = z.number().int().min(0).max(MAX_STATE_VERSION);

export interface FindingRepositoryOptions {
  readonly db: Database;
  /** Ambient tenant source; defaults to the AsyncLocalStorage context (TENANT-003). Tests and tools pass one. */
  readonly tenant?: () => string | undefined;
  readonly logger?: Pick<DbLogger, 'info'>;
}

export interface FindingPage {
  readonly items: FindingRow[];
  readonly nextCursor: string | null;
}

function parseInput<V>(schema: z.ZodType<V>, value: unknown, what: string): V {
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

/**
 * Tenant-scoped persistence of findings. Keep it thin: the validator, triage and API layers above it own the
 * transitions and authorisation; this class owns the rows, their input rules and the optimistic-concurrency
 * update that status changes go through (`state_version`, §3.3 pattern).
 */
export class FindingRepository {
  private readonly options: FindingRepositoryOptions;

  constructor(options: FindingRepositoryOptions) {
    this.options = options;
  }

  /** Records a new finding for the ambient tenant. A second finding with the same fingerprint is a `ConflictError`. */
  async create(input: unknown): Promise<FindingRow> {
    const values = parseInput(createSchema, input, 'finding');
    const id = newId();
    return this.run('create', async (tx, tenantId) => {
      const [inserted] = await tx
        .insert(findings)
        .values({
          id,
          tenantId,
          publicId: publicId('fnd', id),
          fingerprint: values.fingerprint,
          title: values.title,
          class: values.class,
          cweId: values.cweId ?? null,
          owaspCategory: values.owaspCategory ?? null,
          severity: values.severity ?? null,
          assetId: values.assetId,
          location: values.location,
          status: values.status,
          baselineStatus: values.baselineStatus ?? null,
          runId: values.runId,
          firstSeenRunId: values.firstSeenRunId,
          lastSeenRunId: values.lastSeenRunId,
          confidence: values.confidence ?? null,
        })
        .returning();
      if (inserted === undefined) throw new Error('finding insert returned no row');
      return { row: inserted, rowCount: 1 };
    });
  }

  /** One finding by id, or `undefined` (also for another tenant's finding: RLS and the tenant filter). */
  async findById(id: string): Promise<FindingRow | undefined> {
    const rowId = parseInput(idSchema, id, 'id');
    return this.run('findById', async (tx, tenantId) => {
      const rows = await tx
        .select()
        .from(findings)
        .where(and(eq(findings.id, rowId), eq(findings.tenantId, tenantId)))
        .limit(1);
      return { row: rows[0], rowCount: rows.length };
    });
  }

  /**
   * A keyset page ordered by `(created_at, id)`, optionally filtered by status (served by the
   * `(tenant_id, status)` index). `limit` defaults to 50 and above 200 is refused, as for every list.
   */
  async list(
    options: { status?: string; cursor?: string; limit?: number } = {},
  ): Promise<FindingPage> {
    const limit = parseInput(
      z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
      options.limit,
      'list options',
    );
    const status =
      options.status === undefined
        ? undefined
        : parseInput(findingStatusSchema, options.status, 'list options');
    const position: CursorPosition | undefined =
      options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    const createdAt = sql`date_trunc('milliseconds', ${findings.createdAt})`;
    return this.run('list', async (tx, tenantId) => {
      const conditions = [eq(findings.tenantId, tenantId)];
      if (status !== undefined) conditions.push(eq(findings.status, status));
      if (position !== undefined) {
        conditions.push(
          sql`(${createdAt}, ${findings.id}) > (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        );
      }
      const rows = await tx
        .select()
        .from(findings)
        .where(and(...conditions))
        .orderBy(createdAt, findings.id)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items.at(-1);
      const nextCursor =
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return { row: { items, nextCursor }, rowCount: items.length };
    });
  }

  /**
   * Applies `patch` only if the row is at `expectedStateVersion`, and bumps it. A stale version is
   * `ConcurrencyError` (412); a missing or foreign row is `NotFoundError`. Two concurrent updates with the same
   * version: one wins, the other gets the 412.
   */
  async update(id: string, expectedStateVersion: number, patch: unknown): Promise<FindingRow> {
    const rowId = parseInput(idSchema, id, 'id');
    const version = parseInput(versionSchema, expectedStateVersion, 'expectedStateVersion');
    const values = parseInput(updateSchema, patch, 'finding update');
    return this.run('update', async (tx, tenantId) => {
      const updated = await tx
        .update(findings)
        .set({ ...values, stateVersion: sql`${findings.stateVersion} + 1` })
        .where(
          and(
            eq(findings.id, rowId),
            eq(findings.tenantId, tenantId),
            eq(findings.stateVersion, version),
          ),
        )
        .returning();
      if (updated[0] !== undefined) return { row: updated[0], rowCount: 1 };
      throw await this.explainMiss(tx, tenantId, rowId);
    });
  }

  /** Records that a run observed a finding. One occurrence per (finding, run): a repeat is a `ConflictError`. */
  async addOccurrence(input: unknown): Promise<FindingOccurrenceRow> {
    const values = parseInput(occurrenceCreateSchema, input, 'finding occurrence');
    const id = newId();
    return this.run(
      'addOccurrence',
      async (tx, tenantId) => {
        const [inserted] = await tx
          .insert(findingOccurrences)
          .values({
            id,
            tenantId,
            findingId: values.findingId,
            runId: values.runId,
            occurrenceStatus: values.occurrenceStatus,
            evidenceChainHead: values.evidenceChainHead ?? null,
            detectedAt: values.detectedAt,
          })
          .returning();
        if (inserted === undefined) throw new Error('finding occurrence insert returned no row');
        return { row: inserted, rowCount: 1 };
      },
      DUPLICATE_OCCURRENCE,
    );
  }

  /** Every occurrence of one finding, oldest first. An unknown or foreign finding has none. */
  async listOccurrences(findingId: string): Promise<FindingOccurrenceRow[]> {
    const rowId = parseInput(idSchema, findingId, 'id');
    return this.run('listOccurrences', async (tx, tenantId) => {
      const rows = await tx
        .select()
        .from(findingOccurrences)
        .where(
          and(eq(findingOccurrences.findingId, rowId), eq(findingOccurrences.tenantId, tenantId)),
        )
        .orderBy(findingOccurrences.detectedAt, findingOccurrences.id);
      return { row: rows, rowCount: rows.length };
    });
  }

  /** Runs `fn` in the ambient tenant's transaction, translating database errors into the typed set. */
  private async run<R>(
    op: string,
    fn: (tx: TenantTx, tenantId: string) => Promise<{ row: R; rowCount: number }>,
    conflict = DUPLICATE_FINDING,
  ): Promise<R> {
    const tenantId = this.tenantId();
    try {
      const { row, rowCount } = await withTenant(this.options.db, tenantId, (tx) =>
        fn(tx, tenantId),
      );
      this.options.logger?.info({ entity: 'finding', op, tenantId, rowCount }, 'db.repo');
      return row;
    } catch (error) {
      throw translate(error, conflict);
    }
  }

  private tenantId(): string {
    const tenantId = (this.options.tenant ?? currentTenantId)();
    if (tenantId === undefined || tenantId === '') {
      throw new TenantContextMissingError('no tenant context: refusing to run a finding query');
    }
    return tenantId;
  }

  /** After a zero-row update: a missing or foreign row is `NotFoundError`, otherwise a stale version. */
  private async explainMiss(tx: TenantTx, tenantId: string, id: string): Promise<Error> {
    const [current] = await tx
      .select({ id: findings.id })
      .from(findings)
      .where(and(eq(findings.id, id), eq(findings.tenantId, tenantId)))
      .limit(1);
    return current === undefined
      ? new NotFoundError('finding not found')
      : new ConcurrencyError('finding');
  }
}

/** Maps a Postgres error to the typed error set: a duplicate is a conflict, FK and CHECK violations are client errors. */
function translate(error: unknown, conflict: string): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown; constraint?: unknown };
  if (pgError.code === UNIQUE_VIOLATION) {
    return new ConflictError(conflict, { cause: error });
  }
  if (pgError.code === FOREIGN_KEY_VIOLATION) {
    return new ForeignKeyError(
      'finding',
      typeof pgError.constraint === 'string' ? pgError.constraint : undefined,
      { cause: error },
    );
  }
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid finding', {
      detail: 'A database check rejected the finding.',
      cause: error,
    });
  }
  return toTenantIsolationError(pgError) ?? error;
}
