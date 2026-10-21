// withTenant / withSystem against a scripted fake node-postgres pool: the exact statements, retry,
// fail-closed validation, nesting and audit behaviour, with no database (DB-004). The real-Postgres
// proofs (isolation, no leak on a reused connection) live in with-tenant.int.test.ts.

import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
  isAppError,
  TenantContextMissingError,
  toProblemDetails,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { createDatabase } from './client.js';
import { dbTxEnvSchema, loadDbTxConfig } from './env.js';
import {
  type DbTxMetrics,
  type SystemAccessEvent,
  TenantContextMismatchError,
  type TxLogger,
  TxRetryExhaustedError,
  withSystem,
  unwrapQueryError,
  withTenant,
} from './with-tenant.js';

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Handler = (statement: Statement, count: number) => void;

/** A pg.Pool whose clients record every statement and may fail one on demand. */
class FakePool extends pg.Pool {
  readonly statements: Statement[] = [];
  connects = 0;
  releases = 0;
  constructor(private readonly handler: Handler = () => undefined) {
    super();
  }
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: never): void;
  override connect(): Promise<pg.PoolClient> {
    this.connects += 1;
    const client = {
      query: (config: { text?: string; values?: unknown[] } | string, values?: unknown[]) => {
        const statement: Statement =
          typeof config === 'string'
            ? { text: config, values: values ?? [] }
            : { text: config.text ?? '', values: config.values ?? values ?? [] };
        this.statements.push(statement);
        try {
          this.handler(statement, this.statements.length);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error('handler failed'));
        }
        return Promise.resolve({ rows: [], rowCount: 0, fields: [], command: '', oid: 0 });
      },
      release: () => {
        this.releases += 1;
      },
    };
    return Promise.resolve(client as unknown as pg.PoolClient);
  }
  texts(): string[] {
    return this.statements.map((s) => s.text.replace(/\s+/g, ' ').trim().toLowerCase());
  }
}

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

function noopLogger(): TxLogger & { events: string[] } {
  const events: string[] = [];
  const at = (_fields: unknown, message?: string): void => {
    events.push(message ?? '');
  };
  return { debug: at, warn: at, error: at, events };
}

const tenantA = newId();
const tenantB = newId();
const fast = { backoffMs: () => 0, maxRetries: 3, isolation: 'read committed' } as const;

function setup(handler?: Handler): { pool: FakePool; db: ReturnType<typeof createDatabase> } {
  const pool = new FakePool(handler);
  return { pool, db: createDatabase(pool) };
}

describe('withTenant statements', () => {
  it('runs BEGIN, a bound transaction-local set_config, the callback and COMMIT', async () => {
    const { pool, db } = setup();
    const result = await withTenant(db, tenantA, () => Promise.resolve('done'), fast);
    expect(result).toBe('done');
    const texts = pool.texts();
    expect(texts[0]).toBe('begin isolation level read committed');
    expect(texts[1]).toContain("set_config('app.tenant_id', $1, true)");
    expect(pool.statements[1]?.values).toEqual([tenantA]);
    expect(texts.at(-1)).toBe('commit');
    expect(pool.releases).toBe(1);
  });

  it('never interpolates the tenant id into SQL', async () => {
    const { pool, db } = setup();
    await withTenant(db, tenantA, () => Promise.resolve(), fast);
    expect(pool.texts().some((text) => text.includes(tenantA))).toBe(false);
  });

  it('normalises an upper-case UUID to lower case before binding', async () => {
    const { pool, db } = setup();
    await withTenant(db, tenantA.toUpperCase(), () => Promise.resolve(), fast);
    expect(pool.statements[1]?.values).toEqual([tenantA]);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const { pool, db } = setup();
    const boom = new Error('boom');
    await expect(withTenant(db, tenantA, () => Promise.reject(boom), fast)).rejects.toBe(boom);
    expect(pool.texts().at(-1)).toBe('rollback');
    expect(pool.texts()).not.toContain('commit');
    expect(pool.releases).toBe(1);
  });

  it.each([
    ['read committed', 'begin isolation level read committed'],
    ['repeatable read', 'begin isolation level repeatable read'],
    ['serializable', 'begin isolation level serializable'],
  ] as const)('opens the transaction at %s', async (isolation, begin) => {
    const { pool, db } = setup();
    await withTenant(db, tenantA, () => Promise.resolve(), { ...fast, isolation });
    expect(pool.texts()[0]).toBe(begin);
  });

  it('passes the tx through as the Drizzle transaction', async () => {
    const { db } = setup();
    await withTenant(
      db,
      tenantA,
      (tx) => {
        expect(typeof tx.execute).toBe('function');
        return Promise.resolve();
      },
      fast,
    );
  });
});

describe('withTenant fails closed on a missing or malformed tenant', () => {
  it.each([undefined, null, ''])('rejects %j as missing before any query', async (value) => {
    const { pool, db } = setup();
    const tenantContextMissing = vi.fn();
    const txRetry = vi.fn();
    const metrics: DbTxMetrics = { txRetry, tenantContextMissing };
    const fn = vi.fn(() => Promise.resolve());
    const error = await withTenant(db, value as unknown as string, fn, { ...fast, metrics }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      name: 'TenantContextMissingError',
      code: 'TENANT_CONTEXT_MISSING',
      meta: { reason: 'missing' },
    });
    expect(fn).not.toHaveBeenCalled();
    expect(pool.connects).toBe(0);
    expect(pool.statements).toHaveLength(0);
    expect(tenantContextMissing).toHaveBeenCalledTimes(1);
  });

  it.each([
    'not-a-uuid',
    ' ',
    `${tenantA} `,
    tenantA.replaceAll('-', ''),
    `{${tenantA}}`,
    "'; DROP TABLE tenants; --",
    '00000000-0000-0000-0000-00000000000g',
    42,
    {},
  ])('rejects %j as invalid_uuid before any query', async (value) => {
    const { pool, db } = setup();
    const tenantContextMissing = vi.fn();
    const txRetry = vi.fn();
    const metrics: DbTxMetrics = { txRetry, tenantContextMissing };
    const error = await withTenant(db, value as unknown as string, () => Promise.resolve(), {
      ...fast,
      metrics,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
      meta: { reason: 'invalid_uuid' },
    });
    expect(pool.connects).toBe(0);
    expect(tenantContextMissing).toHaveBeenCalledTimes(1);
  });

  it('never echoes the offending value in the error message', async () => {
    const { db } = setup();
    const error = await withTenant(db, 'secret-ish-value', () => Promise.resolve(), fast).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).not.toContain('secret-ish-value');
  });

  it('maps to the registered fail-closed problem status via toProblemDetails', async () => {
    const { db } = setup();
    const error = await withTenant(db, '', () => Promise.resolve(), fast).catch((e: unknown) => e);
    expect(isAppError(error)).toBe(true);
    expect(toProblemDetails(error, 'trace-1')).toMatchObject({
      status: 500,
      code: 'TENANT_CONTEXT_MISSING',
    });
  });
});

describe('retry', () => {
  it.each(['40001', '40P01'])('retries once after %s and then succeeds', async (code) => {
    let failures = 0;
    const tenantContextMissing = vi.fn();
    const txRetry = vi.fn();
    const metrics: DbTxMetrics = { txRetry, tenantContextMissing };
    const { pool, db } = setup();
    const fn = vi.fn(() => {
      if (failures === 0) {
        failures += 1;
        return Promise.reject(pgError(code));
      }
      return Promise.resolve('ok');
    });
    await expect(withTenant(db, tenantA, fn, { ...fast, metrics })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(pool.texts().filter((t) => t === 'rollback')).toHaveLength(1);
    expect(pool.texts().filter((t) => t === 'commit')).toHaveLength(1);
    // Each attempt re-sets the context in its own transaction.
    expect(pool.texts().filter((t) => t.includes('set_config'))).toHaveLength(2);
    expect(txRetry).toHaveBeenCalledWith(code);
  });

  it('retries a serialization failure raised by COMMIT itself', async () => {
    let commits = 0;
    const { db } = setup((statement) => {
      if (statement.text.toLowerCase() === 'commit' && (commits += 1) === 1) {
        throw pgError('40001');
      }
    });
    const fn = vi.fn(() => Promise.resolve('ok'));
    await expect(withTenant(db, tenantA, fn, fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a failure wrapped by Drizzle (code on the cause)', async () => {
    let failures = 0;
    const { db } = setup((statement) => {
      if (statement.text.includes('select 1') && (failures += 1) === 1) throw pgError('40001');
    });
    const fn = vi.fn(async (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => {
      await tx.execute(await import('drizzle-orm').then(({ sql }) => sql`select 1`));
      return 'ok';
    });
    await expect(withTenant(db, tenantA, fn, fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exhausts after DB_TX_MAX_RETRIES retries with TX_RETRY_EXHAUSTED (503, retryable)', async () => {
    const { db } = setup();
    const fn = vi.fn(() => Promise.reject(pgError('40001')));
    const error = await withTenant(db, tenantA, fn, { ...fast, maxRetries: 3 }).catch(
      (e: unknown) => e,
    );
    expect(fn).toHaveBeenCalledTimes(4);
    expect(error).toBeInstanceOf(TxRetryExhaustedError);
    expect(error).toMatchObject({
      code: 'TX_RETRY_EXHAUSTED',
      httpStatus: 503,
      retryable: true,
      attempts: 4,
      codes: ['40001', '40001', '40001', '40001'],
    });
    expect((error as Error).cause).toMatchObject({ code: '40001' });
    expect(toProblemDetails(error, 'trace-1')).toMatchObject({
      status: 503,
      code: 'TX_RETRY_EXHAUSTED',
    });
  });

  it('does not retry at all with maxRetries 0', async () => {
    const { db } = setup();
    const fn = vi.fn(() => Promise.reject(pgError('40P01')));
    const error = await withTenant(db, tenantA, fn, { ...fast, maxRetries: 0 }).catch(
      (e: unknown) => e,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(TxRetryExhaustedError);
  });

  it.each(['23505', '42501', '57014', '40002'])('does not retry %s', async (code) => {
    const { db } = setup();
    const failure = pgError(code);
    const fn = vi.fn(() => Promise.reject(failure));
    await expect(withTenant(db, tenantA, fn, fast)).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error with no SQLSTATE', async () => {
    const { db } = setup();
    const fn = vi.fn(() => Promise.reject(new Error('plain')));
    await expect(withTenant(db, tenantA, fn, fast)).rejects.toThrow('plain');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits the configured backoff between attempts', async () => {
    const { db } = setup();
    const backoffMs = vi.fn(() => 0);
    const fn = vi.fn(() => Promise.reject(pgError('40001')));
    await withTenant(db, tenantA, fn, { ...fast, maxRetries: 2, backoffMs }).catch(() => undefined);
    expect(backoffMs.mock.calls).toEqual([[1], [2]]);
  });

  it('logs retries with a hashed tenant, never the raw id', async () => {
    const { db } = setup();
    const logger = noopLogger();
    const lines: unknown[] = [];
    const capture = (fields: unknown): void => {
      lines.push(fields);
    };
    const recording: TxLogger = { debug: capture, warn: capture, error: capture };
    await withTenant(db, tenantA, () => Promise.reject(pgError('40001')), {
      ...fast,
      maxRetries: 1,
      logger: recording,
    }).catch(() => undefined);
    expect(logger.events).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(tenantA);
    expect(JSON.stringify(lines)).toContain('"codes":["40001"');
  });
});

describe('abort signal (kill switch)', () => {
  it('refuses to start when already aborted', async () => {
    const { pool, db } = setup();
    const controller = new AbortController();
    controller.abort(new Error('killed'));
    await expect(
      withTenant(db, tenantA, () => Promise.resolve(), { ...fast, signal: controller.signal }),
    ).rejects.toThrow('killed');
    expect(pool.connects).toBe(0);
  });

  it('rolls back instead of committing when aborted during the callback', async () => {
    const { pool, db } = setup();
    const controller = new AbortController();
    await expect(
      withTenant(
        db,
        tenantA,
        () => {
          controller.abort(new Error('killed'));
          return Promise.resolve('write');
        },
        { ...fast, signal: controller.signal },
      ),
    ).rejects.toThrow('killed');
    expect(pool.texts()).not.toContain('commit');
    expect(pool.texts().at(-1)).toBe('rollback');
  });

  it('stops retrying when aborted during the backoff', async () => {
    const { db } = setup();
    const controller = new AbortController();
    const fn = vi.fn(() => Promise.reject(pgError('40001')));
    const pending = withTenant(db, tenantA, fn, {
      ...fast,
      backoffMs: () => 60_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(fn).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('killed'));
    await expect(pending).rejects.toThrow('killed');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('nesting', () => {
  it('reuses the open transaction for the same tenant', async () => {
    const { pool, db } = setup();
    const seen: unknown[] = [];
    await withTenant(
      db,
      tenantA,
      async (outer) => {
        await withTenant(
          db,
          tenantA.toUpperCase(),
          (inner) => {
            seen.push(inner);
            return Promise.resolve();
          },
          fast,
        );
        seen.push(outer);
      },
      fast,
    );
    expect(seen[0]).toBe(seen[1]);
    expect(pool.connects).toBe(1);
    expect(pool.texts().filter((t) => t.startsWith('begin'))).toHaveLength(1);
    expect(pool.texts().filter((t) => t.includes('set_config'))).toHaveLength(1);
  });

  it('throws TENANT_CONTEXT_CONFLICT for a different tenant and rolls the outer back', async () => {
    const { pool, db } = setup();
    const error = await withTenant(
      db,
      tenantA,
      () => withTenant(db, tenantB, () => Promise.resolve(), fast),
      fast,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantContextMismatchError);
    expect(error).toMatchObject({
      code: 'TENANT_CONTEXT_CONFLICT',
      httpStatus: 500,
      retryable: false,
    });
    expect((error as Error).message).not.toContain(tenantA);
    expect((error as Error).message).not.toContain(tenantB);
    expect(pool.texts().at(-1)).toBe('rollback');
    expect(pool.connects).toBe(1);
  });

  it('does not retry a context conflict', async () => {
    const { db } = setup();
    const inner = vi.fn(() => Promise.resolve());
    const outer = vi.fn(() => withTenant(db, tenantB, inner, fast));
    await expect(withTenant(db, tenantA, outer, fast)).rejects.toBeInstanceOf(
      TenantContextMismatchError,
    );
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it('validates a nested tenant id before comparing contexts', async () => {
    const { db } = setup();
    await expect(
      withTenant(db, tenantA, () => withTenant(db, 'nope', () => Promise.resolve(), fast), fast),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING', meta: { reason: 'invalid_uuid' } });
  });

  it('re-runs a nested callback only through the outer retry', async () => {
    let failures = 0;
    const { pool, db } = setup();
    const inner = vi.fn(() => {
      if (failures === 0) {
        failures += 1;
        return Promise.reject(pgError('40001'));
      }
      return Promise.resolve('ok');
    });
    await expect(
      withTenant(db, tenantA, () => withTenant(db, tenantA, inner, fast), fast),
    ).resolves.toBe('ok');
    expect(inner).toHaveBeenCalledTimes(2);
    expect(pool.connects).toBe(2);
  });

  it('does not reuse a finished transaction from an orphaned continuation', async () => {
    const { pool, db } = setup();
    let orphan: (() => Promise<void>) | undefined;
    await withTenant(
      db,
      tenantA,
      () => {
        orphan = async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await withTenant(db, tenantB, () => Promise.resolve(), fast);
        };
        return Promise.resolve();
      },
      fast,
    );
    // The finished transaction is not reused: the orphan opens (and closes) its own, with no conflict.
    await orphan?.();
    expect(pool.connects).toBe(2);
    expect(pool.texts().filter((t) => t === 'commit')).toHaveLength(2);
  });

  it('keeps concurrent tenants isolated from each other', async () => {
    const { db } = setup();
    const results = await Promise.all(
      [tenantA, tenantB].map((tenant) =>
        withTenant(
          db,
          tenant,
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 2));
            return withTenant(db, tenant, () => Promise.resolve(tenant), fast);
          },
          fast,
        ),
      ),
    );
    expect(results).toEqual([tenantA, tenantB]);
  });
});

describe('withSystem', () => {
  const audit = (): { events: SystemAccessEvent[]; emit: (e: SystemAccessEvent) => void } => {
    const events: SystemAccessEvent[] = [];
    return { events, emit: (event) => void events.push(event) };
  };
  const base = { ...fast, actor: 'ops@blackwing', reason: 'rotate partitions', now: () => 1_000 };

  it('sets no tenant and audits started then succeeded', async () => {
    const { pool, db } = setup();
    const { events, emit } = audit();
    await expect(withSystem(db, () => Promise.resolve(7), { ...base, audit: emit })).resolves.toBe(
      7,
    );
    expect(pool.texts().some((t) => t.includes('set_config'))).toBe(false);
    expect(events).toEqual([
      {
        action: 'db.system_access',
        phase: 'started',
        actor: 'ops@blackwing',
        reason: 'rotate partitions',
        at: 1_000,
      },
      {
        action: 'db.system_access',
        phase: 'succeeded',
        actor: 'ops@blackwing',
        reason: 'rotate partitions',
        at: 1_000,
      },
    ]);
  });

  it('audits a failure and rethrows', async () => {
    const { db } = setup();
    const { events, emit } = audit();
    await expect(
      withSystem(db, () => Promise.reject(new Error('nope')), { ...base, audit: emit }),
    ).rejects.toThrow('nope');
    expect(events.map((e) => e.phase)).toEqual(['started', 'failed']);
  });

  it('fails closed when the started audit event cannot be written', async () => {
    const { pool, db } = setup();
    const fn = vi.fn(() => Promise.resolve());
    await expect(
      withSystem(db, fn, { ...base, audit: () => Promise.reject(new Error('audit down')) }),
    ).rejects.toThrow('audit down');
    expect(fn).not.toHaveBeenCalled();
    expect(pool.connects).toBe(0);
  });

  it('does not fail the work when only the completion audit fails', async () => {
    const { db } = setup();
    let calls = 0;
    const logger = noopLogger();
    await expect(
      withSystem(db, () => Promise.resolve('ok'), {
        ...base,
        logger,
        audit: () => {
          calls += 1;
          if (calls === 2) throw new Error('audit down');
        },
      }),
    ).resolves.toBe('ok');
    expect(logger.events).toContain('db.system_access.audit_failed');
  });

  it.each([
    ['actor', { actor: ' ' }],
    ['reason', { reason: '' }],
  ])('requires a non-blank %s', async (_name, override) => {
    const { pool, db } = setup();
    const { emit } = audit();
    await expect(
      withSystem(db, () => Promise.resolve(), { ...base, ...override, audit: emit }),
    ).rejects.toThrow(TypeError);
    expect(pool.connects).toBe(0);
  });

  it('requires an audit emitter', async () => {
    const { db } = setup();
    await expect(
      withSystem(db, () => Promise.resolve(), { ...base, audit: undefined as never }),
    ).rejects.toThrow(TypeError);
  });

  it('is refused inside withTenant (no fallback to the system context)', async () => {
    const { db } = setup();
    const { emit } = audit();
    await expect(
      withTenant(
        db,
        tenantA,
        () => withSystem(db, () => Promise.resolve(), { ...base, audit: emit }),
        fast,
      ),
    ).rejects.toBeInstanceOf(TenantContextMismatchError);
  });

  it('makes withTenant inside withSystem a conflict', async () => {
    const { db } = setup();
    const { emit } = audit();
    await expect(
      withSystem(db, () => withTenant(db, tenantA, () => Promise.resolve(), fast), {
        ...base,
        audit: emit,
      }),
    ).rejects.toBeInstanceOf(TenantContextMismatchError);
  });

  it('retries like withTenant but audits only once', async () => {
    let failures = 0;
    const { db } = setup();
    const { events, emit } = audit();
    await withSystem(
      db,
      () => {
        if (failures === 0) {
          failures += 1;
          return Promise.reject(pgError('40001'));
        }
        return Promise.resolve();
      },
      { ...base, audit: emit },
    );
    expect(events.map((e) => e.phase)).toEqual(['started', 'succeeded']);
  });
});

describe('transaction settings', () => {
  it('defaults to 3 retries at read committed', () => {
    expect(loadDbTxConfig({})).toEqual({ maxRetries: 3, isolation: 'read committed' });
  });

  it('reads DB_TX_MAX_RETRIES and DB_TX_ISOLATION', () => {
    expect(loadDbTxConfig({ DB_TX_MAX_RETRIES: '5', DB_TX_ISOLATION: 'serializable' })).toEqual({
      maxRetries: 5,
      isolation: 'serializable',
    });
  });

  it.each([
    { DB_TX_MAX_RETRIES: '-1' },
    { DB_TX_MAX_RETRIES: '11' },
    { DB_TX_MAX_RETRIES: '1.5' },
    { DB_TX_MAX_RETRIES: 'many' },
    { DB_TX_ISOLATION: 'read uncommitted' },
    { DB_TX_ISOLATION: 'snapshot' },
  ])('rejects %j', (env) => {
    expect(dbTxEnvSchema.safeParse(env).success).toBe(false);
  });

  it('rejects a negative maxRetries override', async () => {
    const { db } = setup();
    await expect(
      withTenant(db, tenantA, () => Promise.resolve(), { ...fast, maxRetries: -1 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('mapping of tenant-isolation errors', () => {
  it('maps RLS violations to AppErrors, looking through wrapped driver errors', async () => {
    const rls = Object.assign(new Error('new row violates row-level security policy'), {
      code: '42501',
    });
    const { db } = setup();
    const error = await withTenant(
      db,
      tenantA,
      () => Promise.reject(new Error('Failed query', { cause: rls })),
      fast,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('maps a missing app.tenant_id raised by the database to TENANT_CONTEXT_MISSING', async () => {
    const missing = Object.assign(
      new Error('unrecognized configuration parameter "app.tenant_id"'),
      {
        code: '42704',
      },
    );
    const { db } = setup();
    const error = await withSystem(db, () => Promise.reject(missing), {
      ...fast,
      actor: 'ops',
      reason: 'reads a tenant table without a tenant',
      audit: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantContextMissingError);
    expect(error).toMatchObject({ meta: { reason: 'missing' } });
  });

  it('rethrows unrelated errors unchanged', async () => {
    const failure = new Error('plain');
    const { db } = setup();
    await expect(withTenant(db, tenantA, () => Promise.reject(failure), fast)).rejects.toBe(
      failure,
    );
  });
});

describe('unwrapQueryError', () => {
  it('returns the innermost error that carries a code, or the input', () => {
    const inner = Object.assign(new Error('inner'), { code: '23503' });
    expect(unwrapQueryError(new Error('outer', { cause: inner }))).toBe(inner);
    const plain = new Error('plain');
    expect(unwrapQueryError(plain)).toBe(plain);
    expect(unwrapQueryError(undefined)).toBeUndefined();
  });
});
