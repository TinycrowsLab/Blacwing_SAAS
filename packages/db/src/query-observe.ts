// Per-query observability for the pooled connections (DB-007): a `db.query` trace span, the
// `db_query_duration_ms` histogram, `db.query.slow` above the threshold and `db.query.timeout` on a
// statement timeout. The SQL text and its parameters are never logged, traced or measured: only the
// statement's leading keyword, from a fixed set, identifies it.

import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

import type pg from 'pg';

/** The logger surface needed here (a subset of the pool's `DbLogger`; kept local to avoid an import cycle with pool.ts). */
interface ObserverLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The metrics surface needed here (a subset of the pool's `DbPoolMetrics`). */
interface ObserverMetrics {
  queryDuration(op: string, durationMs: number): void;
}

/** What {@link instrumentClient} reports to. */
export interface QueryObserver {
  readonly pool: string;
  readonly logger: ObserverLogger;
  readonly metrics: ObserverMetrics;
  readonly slowQueryMs: number;
}

/** Statement keywords reported as `op`. Anything else is `OTHER`, so the label set stays bounded. */
const OPERATIONS: ReadonlySet<string> = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'SHOW',
]);

const SQLSTATE = /^[0-9A-Z]{5}$/;
const STATEMENT_TIMEOUT = '57014';
const INSTRUMENTED = Symbol.for('@blackwing/db.instrumented');
const TRACER_NAME = '@blackwing/db';

/** The statement's leading keyword (`SELECT`, `INSERT`, ...), or `OTHER`. Never the text itself. */
export function queryOperation(text: unknown): string {
  if (typeof text !== 'string') return 'OTHER';
  const keyword = /^\s*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase() ?? '';
  return OPERATIONS.has(keyword) ? keyword : 'OTHER';
}

function sqlstateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined;
}

/** The row count of a node-postgres result, when it reports one. */
function rowCountOf(result: unknown): number | undefined {
  const rowCount = (result as { rowCount?: unknown } | null | undefined)?.rowCount;
  return typeof rowCount === 'number' ? rowCount : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * Wraps `client.query` once per connection so every statement is timed and traced, whether it is
 * promise-style (drizzle, direct client use) or callback-style: node-postgres' `Pool.query` reaches
 * the client as `client.query(text, values, callback)`, so skipping callbacks would leave every
 * `pool.query(...)` unobserved. Results and errors pass through unchanged: this observes, it never
 * maps. Submittable objects without a callback are left to node-postgres.
 */
export function instrumentClient(client: pg.PoolClient, observer: QueryObserver): void {
  const target = client as unknown as Record<PropertyKey, unknown> & {
    query: (...args: unknown[]) => unknown;
  };
  if (target[INSTRUMENTED] === true) return;
  Object.defineProperty(target, INSTRUMENTED, { value: true, enumerable: false });
  const original = target.query;

  target.query = function observedQuery(this: unknown, ...args: unknown[]): unknown {
    const first = args[0];
    const op = queryOperation(
      typeof first === 'string' ? first : (first as { text?: unknown } | undefined)?.text,
    );
    const started = performance.now();
    const span = trace
      .getTracer(TRACER_NAME)
      .startSpan(
        'db.query',
        { attributes: { 'db.operation': op, 'db.pool': observer.pool } },
        context.active(),
      );
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      const observedCallback = (...results: unknown[]): unknown => {
        const [error, result] = results;
        settle(
          observer,
          op,
          started,
          span,
          error === undefined || error === null ? undefined : sqlstateOf(error),
          rowCountOf(result),
        );
        return Reflect.apply(callback, this, results);
      };
      return Reflect.apply(original, this, [...args.slice(0, -1), observedCallback]);
    }
    const pending: unknown = Reflect.apply(original, this, args);
    if (!isPromiseLike(pending)) {
      span.end();
      return pending;
    }
    return pending.then(
      (result: unknown) => {
        settle(observer, op, started, span, undefined, rowCountOf(result));
        return result;
      },
      (error: unknown) => {
        settle(observer, op, started, span, sqlstateOf(error));
        throw error;
      },
    );
  };
}

function settle(
  observer: QueryObserver,
  op: string,
  started: number,
  span: Span,
  sqlstate: string | undefined,
  rowCount?: number,
): void {
  const durationMs = Math.round(performance.now() - started);
  observer.metrics.queryDuration(op, durationMs);
  if (sqlstate !== undefined) span.setStatus({ code: SpanStatusCode.ERROR, message: sqlstate });
  span.end();
  if (sqlstate === STATEMENT_TIMEOUT) {
    observer.logger.warn({ pool: observer.pool, op, durationMs, sqlstate }, 'db.query.timeout');
  }
  if (durationMs >= observer.slowQueryMs) {
    observer.logger.warn(
      { pool: observer.pool, op, durationMs, rowCount: rowCount ?? null },
      'db.query.slow',
    );
  }
}
