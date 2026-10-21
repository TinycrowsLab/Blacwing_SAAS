// The repository pattern (DB-007, CONTEXT_PACK §7, §8.6, §9): a thin, typed CRUD base every domain
// epic composes instead of writing its own data access. It
//   - always runs through `withTenant` (no raw pool access), so RLS confines every statement and a
//     missing tenant context fails closed with `TenantContextMissingError`;
//   - guards updates with `state_version` (optimistic concurrency, `ConcurrencyError` -> HTTP 412);
//   - pages with keyset pagination on `(created_at, id)` and opaque, validated cursors;
//   - validates every input with Zod at the boundary and logs `{entity, op, tenantId, rowCount}` only;
//   - hands mutating operations to an audit hook inside the same transaction (§8.8).
// Domain epics copy `examples/widget.repository.ts` and its cross-tenant test.

import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';

import { toTenantIsolationError } from './rls.js';
import { unwrapQueryError, withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type { DbLogger } from './pool.js';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/** Default and maximum page size of {@link BaseRepository.list}. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** The columns a repository table must carry: the DB-004 mixins (tenant, timestamps, version, soft delete). */
export type RepositoryTable = PgTable & {
  id: AnyPgColumn;
  tenantId: AnyPgColumn;
  createdAt: AnyPgColumn;
  stateVersion: AnyPgColumn;
  deletedAt: AnyPgColumn;
};

/** Row type of a repository table. */
export type RowOf<T extends RepositoryTable> = T['$inferSelect'];

/** `update` found the row, but its `state_version` is not the expected one (HTTP 412). */
export class ConcurrencyError extends PreconditionFailedError {
  constructor(entity: string, options: { readonly cause?: unknown } = {}) {
    super(`${entity} was modified concurrently`, {
      detail: 'The resource changed since it was read. Reload it and retry.',
      ...options,
    });
    this.name = 'ConcurrencyError';
  }
}

/** The pagination cursor is malformed or forged. Machine reason: `cursor_invalid`. */
export class CursorInvalidError extends ValidationError {
  readonly reason = 'cursor_invalid' as const;
  constructor() {
    super('cursor_invalid', { detail: 'cursor_invalid: the cursor is not valid.' });
    this.name = 'CursorInvalidError';
  }
}

/** A foreign key blocked the operation (deleting a referenced row, or referencing a missing one). */
export class ForeignKeyError extends ConflictError {
  /** Name of the violated constraint (a schema identifier, safe to expose). */
  readonly constraint: string | undefined;
  constructor(entity: string, constraint: string | undefined, options: { cause?: unknown } = {}) {
    super(`${entity} violates a foreign key`, {
      detail: 'The resource is referenced by, or references, another resource.',
      ...options,
    });
    this.name = 'ForeignKeyError';
    this.constraint = constraint;
  }
}

// --- cursors -----------------------------------------------------------------------------------

const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const cursorSchema = z.strictObject({
  t: z.iso.datetime(),
  i: z.uuid(),
});

/** Decoded keyset position: the last row of a page. */
export interface CursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/** Opaque cursor (base64url JSON) for the page that ends at `position`. */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify({ t: position.createdAt.toISOString(), i: position.id }),
  ).toString('base64url');
}

/** Parses a cursor; every failure is {@link CursorInvalidError}, never a partial result. */
export function decodeCursor(cursor: string): CursorPosition {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    throw new CursorInvalidError();
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorInvalidError();
  }
  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success) throw new CursorInvalidError();
  return { createdAt: new Date(parsed.data.t), id: parsed.data.i };
}

// --- options and ports -------------------------------------------------------------------------

const listOptionsSchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  includeDeleted: z.boolean().default(false),
});

/** Options of {@link BaseRepository.list}. `limit` defaults to 50 and above 200 is rejected. */
export type ListOptions = z.input<typeof listOptionsSchema>;

/** A page: `nextCursor` is `null` on the last page, and `items` is `[]` for no rows. */
export interface RepositoryPage<R> {
  readonly items: readonly R[];
  readonly nextCursor: string | null;
}

export type RepositoryOp = 'create' | 'update' | 'soft_delete' | 'delete';

/** Handed to the audit hook for every mutation. Carries ids and versions, never row contents. */
export interface RepositoryAuditEvent {
  readonly entity: string;
  readonly op: RepositoryOp;
  readonly tenantId: string;
  readonly id: string;
  /** `state_version` after the mutation; absent for a hard delete. */
  readonly stateVersion?: number;
}

/**
 * Audit hook (§8.8). It runs inside the mutation's transaction with the tenant-scoped handle, so a
 * domain epic can append its audit event atomically; if it throws, the mutation rolls back.
 */
export type AuditEmitter = (event: RepositoryAuditEvent, tx: TenantTx) => void | Promise<void>;

/** Trace port: wraps each method in a span named `repo.<entity>.<op>`. Defaults to a passthrough. */
export interface RepositoryTracer {
  span<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** The ambient tenant: returns the current tenant id, or `undefined` when there is none (fail closed). */
export type TenantContextSource = () => string | undefined;

export interface RepositoryConfig<T extends RepositoryTable, C extends object, U extends object> {
  /** Entity name for spans, logs and error messages, e.g. `widget`. */
  readonly entity: string;
  readonly table: T;
  readonly db: Database;
  /** Supplies the ambient tenant id; TENANT-003 provides the request-scoped source. */
  readonly tenant: TenantContextSource;
  /** Zod schema of `create` input. Must not accept `id`, `tenantId` or `stateVersion`. */
  readonly createSchema: z.ZodType<C>;
  /** Zod schema of the `update` patch. Must not accept `id`, `tenantId`, `stateVersion` or `deletedAt`. */
  readonly updateSchema: z.ZodType<U>;
  readonly audit?: AuditEmitter;
  readonly logger?: Pick<DbLogger, 'info'>;
  readonly tracer?: RepositoryTracer;
}

/** Columns a caller can never write through `create` / `update`, whatever the schema accepts. */
const PROTECTED_KEYS = [
  'id',
  'tenantId',
  'createdAt',
  'updatedAt',
  'stateVersion',
  'deletedAt',
] as const;

function stripProtected(value: object): Record<string, unknown> {
  const blocked: readonly string[] = PROTECTED_KEYS;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.includes(key)));
}

const idSchema = z.uuid();
/** `state_version` is a Postgres `integer`. */
const MAX_STATE_VERSION = 2_147_483_647;
const versionSchema = z.number().int().min(0).max(MAX_STATE_VERSION);

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

const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Typed CRUD over one tenant-scoped table. Keep it thin: compose it (a domain repository holds one or
 * extends it with its own queries run through {@link BaseRepository.run}), do not build a hierarchy.
 */
export class BaseRepository<
  T extends RepositoryTable,
  C extends object = Record<string, unknown>,
  U extends object = Record<string, unknown>,
> {
  protected readonly config: RepositoryConfig<T, C, U>;
  /** The table as a plain `PgTable`, the form Drizzle's `from()` accepts for a generic `T`. */
  private readonly source: PgTable;

  constructor(config: RepositoryConfig<T, C, U>) {
    this.config = config;
    this.source = config.table;
  }

  /** One row by id, or `undefined` (also for another tenant's row). Soft-deleted rows are excluded unless `includeDeleted`. */
  async findById(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<RowOf<T> | undefined> {
    const rowId = parseInput(idSchema, id, 'id');
    return this.run('findById', async (tx, tenantId) => {
      const rows = (await tx
        .select()
        .from(this.source)
        .where(and(eq(this.config.table.id, rowId), this.visible(tenantId, options.includeDeleted)))
        .limit(1)) as RowOf<T>[];
      return { result: rows[0], rowCount: rows.length };
    });
  }

  /**
   * Keyset page ordered by `(created_at, id)` ascending. The sort key is `created_at` truncated to
   * milliseconds, the precision a cursor carries, so concatenated pages equal the unpaginated query.
   */
  async list(options: ListOptions = {}): Promise<RepositoryPage<RowOf<T>>> {
    const { cursor, limit, includeDeleted } = parseInput(
      listOptionsSchema,
      options,
      'list options',
    );
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    const { table } = this.config;
    const createdAt = sql`date_trunc('milliseconds', ${table.createdAt})`;
    return this.run('list', async (tx, tenantId) => {
      const conditions: (SQL | undefined)[] = [this.visible(tenantId, includeDeleted)];
      if (position !== undefined) {
        conditions.push(
          sql`(${createdAt}, ${table.id}) > (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        );
      }
      const rows = (await tx
        .select()
        .from(this.source)
        .where(and(...conditions))
        .orderBy(asc(createdAt), asc(table.id))
        .limit(limit + 1)) as RowOf<T>[];
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items.at(-1) as { createdAt: Date; id: string } | undefined;
      const nextCursor =
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return { result: { items, nextCursor }, rowCount: items.length };
    });
  }

  /** Inserts a row for the ambient tenant; the tenant id is never taken from the input. */
  async create(input: C): Promise<RowOf<T>> {
    const values = stripProtected(parseInput(this.config.createSchema, input, 'create input'));
    return this.required(
      await this.mutate('create', async (tx, tenantId) => {
        const rows = (await tx
          .insert(this.config.table)
          .values({ ...values, tenantId } as T['$inferInsert'])
          .returning()) as RowOf<T>[];
        return { row: rows[0], rowCount: 1 };
      }),
    );
  }

  /**
   * Applies `changes` only if the row's `state_version` equals `expectedStateVersion`, and increments
   * it. A stale version throws {@link ConcurrencyError}; a missing, deleted or foreign row throws
   * `NotFoundError`. Two concurrent updates with the same version: one wins, the other gets the 412.
   */
  async update(id: string, expectedStateVersion: number, changes: U): Promise<RowOf<T>> {
    const rowId = parseInput(idSchema, id, 'id');
    const version = parseInput(versionSchema, expectedStateVersion, 'expectedStateVersion');
    const values = stripProtected(parseInput(this.config.updateSchema, changes, 'update input'));
    return this.required(
      await this.mutate('update', async (tx, tenantId) => {
        const { table } = this.config;
        const rows = (await tx
          .update(table)
          .set({ ...values, stateVersion: sql`${table.stateVersion} + 1` } as never)
          .where(and(eq(table.id, rowId), eq(table.stateVersion, version), this.visible(tenantId)))
          .returning()) as RowOf<T>[];
        const row = rows[0];
        if (row !== undefined) return { row, rowCount: 1 };
        await this.explainMiss(tx, tenantId, rowId);
        throw new ConcurrencyError(this.config.entity);
      }),
    );
  }

  /**
   * Marks the row deleted (`deleted_at = now()`) and bumps `state_version`. Pass `expectedStateVersion`
   * to make it version-checked like {@link BaseRepository.update}. Idempotence: an already deleted row is `NotFoundError`.
   */
  async softDelete(id: string, expectedStateVersion?: number): Promise<RowOf<T>> {
    const rowId = parseInput(idSchema, id, 'id');
    const version =
      expectedStateVersion === undefined
        ? undefined
        : parseInput(versionSchema, expectedStateVersion, 'expectedStateVersion');
    return this.required(
      await this.mutate('soft_delete', async (tx, tenantId) => {
        const { table } = this.config;
        const rows = (await tx
          .update(table)
          .set({ deletedAt: sql`now()`, stateVersion: sql`${table.stateVersion} + 1` } as never)
          .where(
            and(
              eq(table.id, rowId),
              version === undefined ? undefined : eq(table.stateVersion, version),
              this.visible(tenantId),
            ),
          )
          .returning()) as RowOf<T>[];
        const row = rows[0];
        if (row !== undefined) return { row, rowCount: 1 };
        await this.explainMiss(tx, tenantId, rowId);
        throw new ConcurrencyError(this.config.entity);
      }),
    );
  }

  /** Physically removes the row. A row still referenced by a foreign key throws {@link ForeignKeyError}. */
  async delete(id: string): Promise<void> {
    const rowId = parseInput(idSchema, id, 'id');
    await this.mutate('delete', async (tx, tenantId) => {
      const { table } = this.config;
      const rows = (await tx
        .delete(table)
        .where(and(eq(table.id, rowId), eq(table.tenantId, tenantId)))
        .returning({ id: table.id })) as { id: string }[];
      if (rows.length === 0) throw new NotFoundError(`${this.config.entity} not found`);
      return { row: undefined, rowCount: 1, id: rowId };
    });
  }

  /**
   * The extension point for domain queries: runs `fn` in the ambient tenant's transaction with a span
   * and the structured log line. `fn` returns the result and the number of rows it touched.
   */
  protected async run<R>(
    op: string,
    fn: (tx: TenantTx, tenantId: string) => Promise<{ result: R; rowCount: number }>,
  ): Promise<R> {
    const tenantId = this.tenantId();
    const { entity, logger, db, tracer } = this.config;
    const execute = async (): Promise<R> => {
      try {
        const { result, rowCount } = await withTenant(db, tenantId, (tx) => fn(tx, tenantId));
        logger?.info({ entity, op, tenantId, rowCount }, 'db.repo');
        return result;
      } catch (error) {
        throw this.translate(error);
      }
    };
    return tracer === undefined ? execute() : tracer.span(`repo.${entity}.${op}`, execute);
  }

  private async mutate(
    op: RepositoryOp,
    fn: (
      tx: TenantTx,
      tenantId: string,
    ) => Promise<{ row: RowOf<T> | undefined; rowCount: number; id?: string }>,
  ): Promise<RowOf<T> | undefined> {
    return this.run(op, async (tx, tenantId) => {
      const { row, rowCount, id } = await fn(tx, tenantId);
      const stored = row as { id: string; stateVersion: number } | undefined;
      await this.config.audit?.(
        {
          entity: this.config.entity,
          op,
          tenantId,
          id: stored?.id ?? id ?? '',
          ...(stored === undefined ? {} : { stateVersion: stored.stateVersion }),
        },
        tx,
      );
      return { result: row, rowCount };
    });
  }

  private tenantId(): string {
    const tenantId = this.config.tenant();
    if (tenantId === undefined || tenantId === '') {
      throw new TenantContextMissingError(
        `no tenant context: refusing to run ${this.config.entity} query`,
      );
    }
    return tenantId;
  }

  /** Tenant filter (defence in depth next to RLS) plus the soft-delete filter. */
  private visible(tenantId: string, includeDeleted = false): SQL | undefined {
    const { table } = this.config;
    return and(eq(table.tenantId, tenantId), includeDeleted ? undefined : isNull(table.deletedAt));
  }

  private required(row: RowOf<T> | undefined): RowOf<T> {
    if (row === undefined) throw new NotFoundError(`${this.config.entity} not found`);
    return row;
  }

  /** After a zero-row update: a missing / deleted / foreign row is `NotFoundError`, otherwise it is a stale version. */
  private async explainMiss(tx: TenantTx, tenantId: string, id: string): Promise<void> {
    const { table } = this.config;
    const existing = await tx
      .select({ id: table.id })
      .from(this.source)
      .where(and(eq(table.id, id), this.visible(tenantId)))
      .limit(1);
    if (existing.length === 0) throw new NotFoundError(`${this.config.entity} not found`);
  }

  private translate(error: unknown): unknown {
    const pgError = unwrapQueryError(error) as { code?: unknown; constraint?: unknown };
    if (pgError.code === FOREIGN_KEY_VIOLATION) {
      return new ForeignKeyError(
        this.config.entity,
        typeof pgError.constraint === 'string' ? pgError.constraint : undefined,
        { cause: error },
      );
    }
    return toTenantIsolationError(pgError) ?? error;
  }
}
