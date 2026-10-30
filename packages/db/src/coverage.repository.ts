// Coverage manifest persistence (COVERAGE-001, F19, CONTEXT_PACK §7). A run has one manifest (`cov_…`). Its rows
// (one per test case) can be recorded and updated only while the manifest is `open`: the write takes the manifest
// row lock, reads its status, and refuses a finalised manifest (COVERAGE-004 flips the status and adds the
// finalisation audit). Every method runs through `withTenant`, so RLS confines it and a missing tenant context fails
// closed. The unique `(tenant_id, run_id)` constraint is the one-manifest-per-run arbiter; the composite foreign keys
// keep a manifest and its rows inside one tenant.

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { type CoverageManifestEntry, coverageManifestEntrySchema } from '@blackwing/contracts';
import {
  ConflictError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { publicId } from './columns.js';
import { toTenantIsolationError } from './rls.js';
import { coverageEntries, type CoverageEntryRow } from './schema/coverage-entries.js';
import { type CoverageManifestRow, coverageManifests } from './schema/coverage-manifests.js';
import { runs } from './schema/runs.js';
import { currentTenantId } from './tenant-context.js';
import { type TenantTx, unwrapQueryError, withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { DbLogger } from './pool.js';

/** A manifest with its rows, in test-case-id order. */
export interface CoverageManifestWithEntries {
  readonly manifest: CoverageManifestRow;
  readonly entries: readonly CoverageEntryRow[];
}

/** `createManifest` input. The tenant is never accepted here: it is the ambient tenant of the call. */
const createSchema = z.strictObject({ runId: z.uuid() });

const idSchema = z.uuid();

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

interface CoverageRepositoryOptions {
  readonly db: Database;
  readonly logger?: Pick<DbLogger, 'info'>;
  /** Ambient tenant source; defaults to the AsyncLocalStorage context (TENANT-003). Tests and tools pass one. */
  readonly tenant?: () => string | undefined;
}

/** Parses untrusted input, reporting field paths only (issue messages can echo input values). */
function parseInput<V>(schema: z.ZodType<V>, value: unknown, what: string): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError(`invalid ${what}`, {
      detail: `Invalid ${what}: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return result.data;
}

/** Maps database errors onto the typed error set. Anything else passes through unchanged. */
function translate(error: unknown): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown; constraint?: unknown };
  if (pgError.code === UNIQUE_VIOLATION) {
    return new ConflictError('a coverage manifest already exists for this run', { cause: error });
  }
  if (pgError.code === FOREIGN_KEY_VIOLATION) {
    return new NotFoundError('run or test case not found', { cause: error });
  }
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid coverage entry', {
      detail: 'A database check rejected the coverage entry.',
      cause: error,
    });
  }
  return toTenantIsolationError(pgError) ?? error;
}

/** The column values of one coverage row, from its validated input. */
function entryValues(entry: CoverageManifestEntry, manifestId: string, tenantId: string) {
  return {
    tenantId,
    manifestId,
    testCaseId: entry.testCaseId,
    title: entry.title,
    class: entry.class,
    owaspRefs: entry.owaspRefs,
    wstgRefs: entry.wstgRefs,
    cweCandidates: entry.cweCandidates,
    targets: entry.targets,
    roles: entry.roles,
    outcome: entry.outcome,
    reason: entry.reason,
    subtaskId: entry.subtaskId,
    budgetUsed: entry.budgetUsed,
  };
}

/**
 * Tenant-scoped persistence of coverage manifests and their per-case rows. Thin on purpose: population of the rows
 * from a run (COVERAGE-002) and finalisation (COVERAGE-004) build on these methods.
 */
export class CoverageRepository {
  private readonly options: CoverageRepositoryOptions;

  constructor(options: CoverageRepositoryOptions) {
    this.options = options;
  }

  /**
   * Creates the open manifest of a run. An unknown run, or one of another tenant (RLS hides it), is `NotFoundError`.
   * A second manifest for the same run is `ConflictError`.
   */
  async createManifest(input: unknown): Promise<CoverageManifestRow> {
    const { runId } = parseInput(createSchema, input, 'coverage manifest');
    return this.run('createManifest', runId, async (tx, tenantId) => {
      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.tenantId, tenantId)))
        .limit(1);
      if (run === undefined) throw new NotFoundError('run not found');

      const id = newId();
      const [row] = await tx
        .insert(coverageManifests)
        .values({ id, tenantId, publicId: publicId('cov', id), runId, status: 'open' })
        .returning();
      if (row === undefined) throw new Error('coverage manifest insert returned no row');
      return { row, rowCount: 1 };
    });
  }

  /** The manifest of a run with its rows, or `undefined` when the run has none (also for another tenant's run). */
  async findByRun(runId: string): Promise<CoverageManifestWithEntries | undefined> {
    const rid = parseInput(idSchema, runId, 'runId');
    return this.run('findByRun', rid, async (tx, tenantId) => {
      const [manifest] = await tx
        .select()
        .from(coverageManifests)
        .where(and(eq(coverageManifests.runId, rid), eq(coverageManifests.tenantId, tenantId)))
        .limit(1);
      if (manifest === undefined) return { row: undefined, rowCount: 0 };
      const entries = await tx
        .select()
        .from(coverageEntries)
        .where(
          and(eq(coverageEntries.manifestId, manifest.id), eq(coverageEntries.tenantId, tenantId)),
        )
        .orderBy(asc(coverageEntries.testCaseId));
      return { row: { manifest, entries }, rowCount: 1 + entries.length };
    });
  }

  /**
   * Records one test case's row in an open manifest, or updates it when the case already has one (keyed by
   * `(manifest_id, test_case_id)`). A finalised manifest is `ConflictError`, and an unknown manifest or case is
   * `NotFoundError`. The manifest row is locked for the write, so a concurrent finalisation cannot interleave.
   */
  async upsertEntry(manifestId: string, input: unknown): Promise<CoverageEntryRow> {
    const mid = parseInput(idSchema, manifestId, 'manifestId');
    const entry = parseInput(coverageManifestEntrySchema, input, 'coverage entry');
    return this.run('upsertEntry', mid, async (tx, tenantId) => {
      const [manifest] = await tx
        .select({ id: coverageManifests.id, status: coverageManifests.status })
        .from(coverageManifests)
        .where(and(eq(coverageManifests.id, mid), eq(coverageManifests.tenantId, tenantId)))
        .limit(1)
        .for('update');
      if (manifest === undefined) throw new NotFoundError('coverage manifest not found');
      if (manifest.status !== 'open') {
        throw new ConflictError('coverage manifest is finalised', {
          detail: 'A finalised coverage manifest is immutable; its rows cannot change.',
        });
      }

      const values = entryValues(entry, mid, tenantId);
      const [row] = await tx
        .insert(coverageEntries)
        .values({ id: newId(), ...values })
        .onConflictDoUpdate({
          target: [coverageEntries.manifestId, coverageEntries.testCaseId],
          set: {
            title: values.title,
            class: values.class,
            owaspRefs: values.owaspRefs,
            wstgRefs: values.wstgRefs,
            cweCandidates: values.cweCandidates,
            targets: values.targets,
            roles: values.roles,
            outcome: values.outcome,
            reason: values.reason,
            subtaskId: values.subtaskId,
            budgetUsed: values.budgetUsed,
          },
        })
        .returning();
      if (row === undefined) throw new Error('coverage entry upsert returned no row');
      return { row, rowCount: 1 };
    });
  }

  /** The rows of a manifest, in test-case-id order. An unknown manifest, or another tenant's, yields an empty list. */
  async listEntries(manifestId: string): Promise<CoverageEntryRow[]> {
    const mid = parseInput(idSchema, manifestId, 'manifestId');
    return this.run('listEntries', mid, async (tx, tenantId) => {
      const rows = await tx
        .select()
        .from(coverageEntries)
        .where(and(eq(coverageEntries.manifestId, mid), eq(coverageEntries.tenantId, tenantId)))
        .orderBy(asc(coverageEntries.testCaseId));
      return { row: rows, rowCount: rows.length };
    });
  }

  /** Runs `fn` in the ambient tenant's transaction, translating database errors into the typed set. */
  private async run<R>(
    op: string,
    subject: string,
    fn: (tx: TenantTx, tenantId: string) => Promise<{ row: R; rowCount: number }>,
  ): Promise<R> {
    const tenantId = this.tenantId();
    try {
      const { row, rowCount } = await withTenant(this.options.db, tenantId, (tx) =>
        fn(tx, tenantId),
      );
      this.options.logger?.info(
        { entity: 'coverage_manifest', op, tenantId, subject, rowCount },
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
      throw new TenantContextMissingError('no tenant context: refusing to run a coverage query');
    }
    return tenantId;
  }
}
