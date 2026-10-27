// Assessment-request persistence (SCOPE-001, CONTEXT_PACK §7, §8.3, §8.6, §8.8). The scoping form's output
// is a draft until it is submitted, then promoted or rejected; the `runs` row belongs to ORCH. Every method
// runs through `withTenant`, so RLS confines it and a missing tenant context fails closed. Each creation and
// status change writes its audit event through the audit hook inside the same transaction: a change that
// cannot be audited does not happen.

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  type AssessmentRequestStatus,
  assessmentRequestStatusSchema,
  authorisableIntrusivenessSchema,
  canTransitionAssessmentRequest,
  LIMITS,
  type RunMode,
  runBudgetsSchema,
  runModeSchema,
  runTriggerSchema,
  scopeRulesSchema,
} from '@blackwing/contracts';
import {
  ConflictError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { publicId } from './columns.js';
import { ConcurrencyError, ForeignKeyError } from './repository.js';
import { toTenantIsolationError } from './rls.js';
import { assessmentRequests } from './schema/scope.js';
import { currentTenantId } from './tenant-context.js';
import { unwrapQueryError, type TenantTx, withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { DbLogger } from './pool.js';

/** One row of `assessment_requests`. */
export type AssessmentRequestRow = typeof assessmentRequests.$inferSelect;

/** `create` input. The tenant is never accepted here: it is the ambient tenant of the call. */
const createSchema = z.strictObject({
  mode: runModeSchema,
  objective: z.string().min(1).max(LIMITS.objectiveMax),
  /** May be empty in a draft; submitting requires at least one asset (see `transition`). */
  assetIds: z.array(z.uuid()).default([]),
  saId: z.uuid().nullish(),
  inputManifestId: z.uuid().nullish(),
  scopeRules: scopeRulesSchema.default({ rules: [] }),
  maxIntrusiveness: authorisableIntrusivenessSchema,
  budgets: runBudgetsSchema,
  trigger: runTriggerSchema,
  requestedBy: z.uuid(),
});
export type AssessmentRequestCreate = z.input<typeof createSchema>;

/** Draft patch: every creation field except the requester, which is fixed at creation. */
const updateSchema = createSchema.omit({ requestedBy: true }).partial();
export type AssessmentRequestUpdate = z.input<typeof updateSchema>;

const idSchema = z.uuid();
/** `state_version` is a Postgres `integer`. */
const MAX_STATE_VERSION = 2_147_483_647;
const versionSchema = z.number().int().min(0).max(MAX_STATE_VERSION);

/** Audit event of a request: `scope.request.created` (no `from`) or `scope.request.status_changed`. */
export interface AssessmentRequestAuditEvent {
  readonly action: 'scope.request.created' | 'scope.request.status_changed';
  readonly tenantId: string;
  readonly requestId: string;
  readonly publicId: string;
  readonly mode: RunMode;
  readonly from?: AssessmentRequestStatus;
  readonly to: AssessmentRequestStatus;
  readonly actorId: string;
}

/**
 * Writes the audit event inside the mutation's transaction (§8.8). It is required by the repository: a
 * repository without an audit path cannot exist, so no status change can skip the ledger.
 */
export type AssessmentRequestAuditHook = (
  event: AssessmentRequestAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

/** `scope_requests_total{status,mode}`: counted after the transaction commits. */
export interface AssessmentRequestMetrics {
  requestsTotal(labels: { readonly status: AssessmentRequestStatus; readonly mode: RunMode }): void;
}

const NOOP_METRICS: AssessmentRequestMetrics = { requestsTotal: () => undefined };

export interface AssessmentRequestRepositoryOptions {
  readonly db: Database;
  readonly audit: AssessmentRequestAuditHook;
  readonly metrics?: AssessmentRequestMetrics;
  readonly logger?: Pick<DbLogger, 'info'>;
  /** Ambient tenant source; defaults to the AsyncLocalStorage context (TENANT-003). Tests and tools pass one. */
  readonly tenant?: () => string | undefined;
}

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

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
 * Tenant-scoped persistence of assessment requests. Keep it thin: the service above it (the SCOPE-005 API)
 * owns authorisation and the submit gate; this class owns the rows, the state machine and the audit writes.
 */
export class AssessmentRequestRepository {
  private readonly options: AssessmentRequestRepositoryOptions;

  constructor(options: AssessmentRequestRepositoryOptions) {
    this.options = options;
  }

  /** Creates a `draft` for the ambient tenant and records `scope.request.created`. */
  async create(input: unknown): Promise<AssessmentRequestRow> {
    const values = parseInput(createSchema, input, 'assessment request');
    const id = newId();
    const row = await this.run('create', async (tx, tenantId) => {
      const [inserted] = await tx
        .insert(assessmentRequests)
        .values({
          id,
          tenantId,
          publicId: publicId('areq', id),
          mode: values.mode,
          objective: values.objective,
          assetIds: values.assetIds,
          saId: values.saId ?? null,
          inputManifestId: values.inputManifestId ?? null,
          scopeRules: values.scopeRules,
          maxIntrusiveness: values.maxIntrusiveness,
          budgets: values.budgets,
          trigger: values.trigger,
          requestedBy: values.requestedBy,
        })
        .returning();
      if (inserted === undefined) throw new Error('assessment request insert returned no row');
      await this.options.audit(
        {
          action: 'scope.request.created',
          tenantId,
          requestId: inserted.id,
          publicId: inserted.publicId,
          mode: inserted.mode,
          to: 'draft',
          actorId: values.requestedBy,
        },
        tx,
      );
      return { row: inserted, rowCount: 1 };
    });
    this.afterCommit('create', row, 'draft');
    return row;
  }

  /** One request by id, or `undefined` (also for another tenant's request: RLS and the tenant filter). */
  async findById(id: string): Promise<AssessmentRequestRow | undefined> {
    const rowId = parseInput(idSchema, id, 'id');
    return this.run('findById', async (tx, tenantId) => {
      const rows = await tx
        .select()
        .from(assessmentRequests)
        .where(and(eq(assessmentRequests.id, rowId), eq(assessmentRequests.tenantId, tenantId)))
        .limit(1);
      return { row: rows[0], rowCount: rows.length };
    });
  }

  /**
   * Edits a draft. The row must still be `draft` and at `expectedStateVersion` (optimistic concurrency, If-Match
   * at the API). A stale version is `ConcurrencyError` (412), a non-draft is `ConflictError` (409).
   */
  async updateDraft(
    id: string,
    expectedStateVersion: number,
    patch: unknown,
  ): Promise<AssessmentRequestRow> {
    const rowId = parseInput(idSchema, id, 'id');
    const version = parseInput(versionSchema, expectedStateVersion, 'expectedStateVersion');
    const values = parseInput(updateSchema, patch, 'assessment request update');
    return this.run('updateDraft', async (tx, tenantId) => {
      const updated = await tx
        .update(assessmentRequests)
        .set({ ...values, stateVersion: sql`${assessmentRequests.stateVersion} + 1` })
        .where(
          and(
            eq(assessmentRequests.id, rowId),
            eq(assessmentRequests.tenantId, tenantId),
            eq(assessmentRequests.stateVersion, version),
            eq(assessmentRequests.status, 'draft'),
          ),
        )
        .returning();
      if (updated[0] !== undefined) return { row: updated[0], rowCount: 1 };
      throw await this.explainMiss(tx, tenantId, rowId, version);
    });
  }

  /**
   * Moves a request along the status machine (`ASSESSMENT_REQUEST_TRANSITIONS`) and records
   * `scope.request.status_changed {from,to,actor}` in the same transaction. Submitting requires a standing
   * authorisation (`sa_id`) and at least one asset; the database CHECK is the backstop for both.
   */
  async transition(
    id: string,
    expectedStateVersion: number,
    to: AssessmentRequestStatus,
    actorId: string,
  ): Promise<AssessmentRequestRow> {
    const rowId = parseInput(idSchema, id, 'id');
    const version = parseInput(versionSchema, expectedStateVersion, 'expectedStateVersion');
    const target = parseInput(assessmentRequestStatusSchema, to, 'status');
    const actor = parseInput(idSchema, actorId, 'actor');
    const result = await this.run('transition', async (tx, tenantId) => {
      const [current] = await tx
        .select()
        .from(assessmentRequests)
        .where(and(eq(assessmentRequests.id, rowId), eq(assessmentRequests.tenantId, tenantId)))
        .limit(1)
        .for('update');
      if (current === undefined) throw new NotFoundError('assessment request not found');
      if (current.stateVersion !== version) throw new ConcurrencyError('assessment request');
      if (!canTransitionAssessmentRequest(current.status, target)) {
        throw new ConflictError(
          `assessment request cannot move from ${current.status} to ${target}`,
        );
      }
      if (target === 'submitted' && (current.saId === null || current.assetIds.length === 0)) {
        throw new ValidationError('invalid assessment request', {
          detail: 'Submitting requires a standing authorisation and at least one asset.',
        });
      }
      const [updated] = await tx
        .update(assessmentRequests)
        .set({ status: target, stateVersion: sql`${assessmentRequests.stateVersion} + 1` })
        .where(
          and(
            eq(assessmentRequests.id, rowId),
            eq(assessmentRequests.tenantId, tenantId),
            eq(assessmentRequests.stateVersion, version),
          ),
        )
        .returning();
      if (updated === undefined) throw new ConcurrencyError('assessment request');
      await this.options.audit(
        {
          action: 'scope.request.status_changed',
          tenantId,
          requestId: updated.id,
          publicId: updated.publicId,
          mode: updated.mode,
          from: current.status,
          to: target,
          actorId: actor,
        },
        tx,
      );
      return { row: { row: updated, from: current.status }, rowCount: 1 };
    });
    this.afterCommit('transition', result.row, target, result.from);
    return result.row;
  }

  /** Runs `fn` in the ambient tenant's transaction, translating database errors into the typed set. */
  private async run<R>(
    op: string,
    fn: (tx: TenantTx, tenantId: string) => Promise<{ row: R; rowCount: number }>,
  ): Promise<R> {
    const tenantId = this.tenantId();
    try {
      const { row, rowCount } = await withTenant(this.options.db, tenantId, (tx) =>
        fn(tx, tenantId),
      );
      this.options.logger?.info(
        { entity: 'assessment_request', op, tenantId, rowCount },
        'db.repo',
      );
      return row;
    } catch (error) {
      throw translate(error);
    }
  }

  private tenantId(): string {
    const tenantId = (this.options.tenant ?? currentTenantId)();
    if (tenantId === undefined || tenantId === '') {
      throw new TenantContextMissingError(
        'no tenant context: refusing to run an assessment request query',
      );
    }
    return tenantId;
  }

  /** Metric and structured log line, after the transaction committed (a rolled-back change is not counted). */
  private afterCommit(
    op: 'create' | 'transition',
    row: AssessmentRequestRow,
    to: AssessmentRequestStatus,
    from?: AssessmentRequestStatus,
  ): void {
    (this.options.metrics ?? NOOP_METRICS).requestsTotal({ status: to, mode: row.mode });
    this.options.logger?.info(
      {
        op,
        tenantId: row.tenantId,
        requestId: row.id,
        mode: row.mode,
        ...(from === undefined ? {} : { from }),
        to,
      },
      'scope.request',
    );
  }

  /** After a zero-row draft update: the cause is a missing row, a non-draft or a stale version. */
  private async explainMiss(
    tx: TenantTx,
    tenantId: string,
    id: string,
    version: number,
  ): Promise<Error> {
    const [current] = await tx
      .select({ status: assessmentRequests.status, stateVersion: assessmentRequests.stateVersion })
      .from(assessmentRequests)
      .where(and(eq(assessmentRequests.id, id), eq(assessmentRequests.tenantId, tenantId)))
      .limit(1);
    if (current === undefined) return new NotFoundError('assessment request not found');
    if (current.status !== 'draft') {
      return new ConflictError('assessment request is no longer a draft');
    }
    return current.stateVersion === version
      ? new ConflictError('assessment request was modified concurrently')
      : new ConcurrencyError('assessment request');
  }
}

/** Maps a Postgres error to the typed error set: FK and CHECK violations become client errors. */
function translate(error: unknown): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown; constraint?: unknown };
  if (pgError.code === FOREIGN_KEY_VIOLATION) {
    return new ForeignKeyError(
      'assessment_request',
      typeof pgError.constraint === 'string' ? pgError.constraint : undefined,
      { cause: error },
    );
  }
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid assessment request', {
      detail: 'A database check rejected the assessment request.',
      cause: error,
    });
  }
  return toTenantIsolationError(pgError) ?? error;
}
