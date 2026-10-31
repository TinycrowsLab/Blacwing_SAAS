// Cost aggregation (COST-003, CONTEXT_PACK §7, §8.6, §8.9). Read-only views over `cost_ledger`: totals and
// stage/persona breakdowns per run, and a tenant's total for one calendar month. Every query runs in one
// `withTenant` transaction, so RLS confines it to the tenant and a missing tenant fails closed. Money stays a
// decimal string (`numeric`, never a float) and every sum is computed in SQL, never in memory.

import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

import { costLedger, type Database, withTenant } from '@blackwing/db';
import { ValidationError } from '@blackwing/errors';

/** Totals over a set of ledger rows. An empty set is all zeros, never null. */
export interface CostTotals {
  readonly ledgerRows: number;
  /** Summed `cost_usd` as a decimal string at the ledger's scale (no float drift). */
  readonly costUsd: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

export interface RunCost extends CostTotals {
  readonly runId: string;
}

export interface StageCost extends CostTotals {
  readonly stage: string;
}

/** `persona` is null for orchestrator overhead that no persona owns. */
export interface PersonaCost extends CostTotals {
  readonly persona: string | null;
}

/** Where a month's boundaries were read from: the caller's tenant timezone, or UTC when none was given. */
export type TimeZoneSource = 'tenant' | 'default';

export interface MonthWindow {
  /** Inclusive start instant: local 00:00 on the first day of the month in `timeZone`. */
  readonly start: Date;
  /** Exclusive end instant: local 00:00 on the first day of the next month. */
  readonly end: Date;
  /** The canonical IANA zone the boundaries were computed in. */
  readonly timeZone: string;
  readonly timeZoneSource: TimeZoneSource;
}

export interface TenantMonthCost extends CostTotals {
  /** The calendar month as `YYYY-MM`. */
  readonly month: string;
  readonly timeZone: string;
  readonly timeZoneSource: TimeZoneSource;
  readonly start: Date;
  readonly end: Date;
}

export interface CostAggregates {
  runCost(tenantId: string, runId: string): Promise<RunCost>;
  runStageCost(tenantId: string, runId: string): Promise<StageCost[]>;
  runPersonaCost(tenantId: string, runId: string): Promise<PersonaCost[]>;
  tenantMonthCost(tenantId: string, month: string, timeZone?: string): Promise<TenantMonthCost>;
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/u;
/** Years before this are refused: `Date.UTC` maps 0-99 onto 1900-1999, which would mis-bucket spend. */
const MIN_MONTH_YEAR = 1000;
const DEFAULT_TIME_ZONE = 'UTC';
/** IANA zone names only: `Europe/Berlin`, `UTC`. Numeric offsets such as `+02:00` are not zones (Intl accepts them). */
const IANA_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

const tracer = trace.getTracer('@blackwing/cost');
const aggregateDurationMs = metrics
  .getMeter('@blackwing/cost')
  .createHistogram('cost_aggregate_duration_ms', {
    description: 'Duration of a cost aggregate read, by scope',
    unit: 'ms',
  });

/** The SQL columns every total is built from. Sums are cast to text so no float ever touches a money value. */
const totalColumns = {
  ledgerRows: sql<number>`count(*)::int`,
  costUsd: sql<string>`coalesce(sum(${costLedger.costUsd}), 0)::text`,
  inputTokens: sql<string>`coalesce(sum(${costLedger.inputTokens}), 0)::text`,
  outputTokens: sql<string>`coalesce(sum(${costLedger.outputTokens}), 0)::text`,
  cacheWriteTokens: sql<string>`coalesce(sum(${costLedger.cacheWriteTokens}), 0)::text`,
  cacheReadTokens: sql<string>`coalesce(sum(${costLedger.cacheReadTokens}), 0)::text`,
};

interface RawTotals {
  ledgerRows: number;
  costUsd: string;
  inputTokens: string;
  outputTokens: string;
  cacheWriteTokens: string;
  cacheReadTokens: string;
}

function toTotals(raw: RawTotals): CostTotals {
  return {
    ledgerRows: raw.ledgerRows,
    costUsd: raw.costUsd,
    inputTokens: Number(raw.inputTokens),
    outputTokens: Number(raw.outputTokens),
    cacheWriteTokens: Number(raw.cacheWriteTokens),
    cacheReadTokens: Number(raw.cacheReadTokens),
  };
}

// Zone offsets come from `Intl`, so DST rules are the platform's, not ours.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The zone's offset from UTC at `instantMs`, in milliseconds (positive east of Greenwich). */
function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Map(
    formatterFor(timeZone)
      .formatToParts(instantMs)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wallClockAsUtc = Date.UTC(
    parts.get('year') ?? Number.NaN,
    (parts.get('month') ?? Number.NaN) - 1,
    parts.get('day') ?? Number.NaN,
    parts.get('hour') ?? Number.NaN,
    parts.get('minute') ?? Number.NaN,
    parts.get('second') ?? Number.NaN,
  );
  return wallClockAsUtc - instantMs;
}

/**
 * The UTC instant of local midnight on the first day of `month` (1-12, may be 13 for January of the next
 * year). Two refinements: the first guess may land on the far side of a DST change, so the offset is read
 * again at that instant. Ledger rows bucket on this instant, so a naive UTC month would mis-bucket spend near
 * month edges in any zone east or west of UTC.
 */
function zonedMonthStartMs(year: number, month: number, timeZone: string): number {
  const naive = Date.UTC(year, month - 1, 1);
  const firstGuess = naive - offsetMs(naive, timeZone);
  return naive - offsetMs(firstGuess, timeZone);
}

function resolveTimeZone(timeZone: string | undefined): {
  timeZone: string;
  source: TimeZoneSource;
} {
  if (timeZone === undefined) {
    return { timeZone: DEFAULT_TIME_ZONE, source: 'default' };
  }
  try {
    if (!IANA_ZONE_PATTERN.test(timeZone)) {
      throw new RangeError(timeZone);
    }
    return {
      timeZone: new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone,
      source: 'tenant',
    };
  } catch {
    throw new ValidationError('timeZone must be a known IANA timezone');
  }
}

/**
 * The half-open UTC window [start, end) of one calendar month in the tenant's timezone. `month` is `YYYY-MM`.
 * Without a timezone the window is UTC and labelled `timeZoneSource: 'default'`, so a report can say so.
 */
export function monthWindow(month: string, timeZone?: string): MonthWindow {
  const match = MONTH_PATTERN.exec(month);
  const year = Number(match?.[1]);
  const monthNumber = Number(match?.[2]);
  if (match === null || year < MIN_MONTH_YEAR) {
    throw new ValidationError('month must be a YYYY-MM calendar month');
  }
  const zone = resolveTimeZone(timeZone);
  return {
    start: new Date(zonedMonthStartMs(year, monthNumber, zone.timeZone)),
    end: new Date(zonedMonthStartMs(year, monthNumber + 1, zone.timeZone)),
    timeZone: zone.timeZone,
    timeZoneSource: zone.source,
  };
}

async function measured<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  return tracer.startActiveSpan(
    'cost.aggregate',
    { attributes: { 'cost.scope': scope } },
    async (span) => {
      try {
        return await work();
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        aggregateDurationMs.record(performance.now() - started, { scope });
        span.end();
      }
    },
  );
}

/** Aggregate reads over `cost_ledger`, bound to one database handle. Every method takes the tenant explicitly. */
export function createCostAggregates(db: Database): CostAggregates {
  return {
    async runCost(tenantId, runId) {
      return measured('run', async () => {
        const [row] = await withTenant(db, tenantId, (tx) =>
          tx
            .select(totalColumns)
            .from(costLedger)
            .where(and(eq(costLedger.tenantId, tenantId), eq(costLedger.runId, runId))),
        );
        return { runId, ...toTotals(row ?? emptyRaw()) };
      });
    },

    async runStageCost(tenantId, runId) {
      return measured('run_stage', async () => {
        const rows = await withTenant(db, tenantId, (tx) =>
          tx
            .select({ stage: costLedger.stage, ...totalColumns })
            .from(costLedger)
            .where(and(eq(costLedger.tenantId, tenantId), eq(costLedger.runId, runId)))
            .groupBy(costLedger.stage)
            .orderBy(costLedger.stage),
        );
        return rows.map(({ stage, ...raw }) => ({ stage, ...toTotals(raw) }));
      });
    },

    async runPersonaCost(tenantId, runId) {
      return measured('run_persona', async () => {
        const rows = await withTenant(db, tenantId, (tx) =>
          tx
            .select({ persona: costLedger.persona, ...totalColumns })
            .from(costLedger)
            .where(and(eq(costLedger.tenantId, tenantId), eq(costLedger.runId, runId)))
            .groupBy(costLedger.persona)
            .orderBy(costLedger.persona),
        );
        return rows.map(({ persona, ...raw }) => ({ persona, ...toTotals(raw) }));
      });
    },

    async tenantMonthCost(tenantId, month, timeZone) {
      const window = monthWindow(month, timeZone);
      return measured('tenant_month', async () => {
        const [row] = await withTenant(db, tenantId, (tx) =>
          tx
            .select(totalColumns)
            .from(costLedger)
            .where(
              and(
                eq(costLedger.tenantId, tenantId),
                gte(costLedger.occurredAt, window.start),
                lt(costLedger.occurredAt, window.end),
              ),
            ),
        );
        return {
          month,
          timeZone: window.timeZone,
          timeZoneSource: window.timeZoneSource,
          start: window.start,
          end: window.end,
          ...toTotals(row ?? emptyRaw()),
        };
      });
    },
  };
}

function emptyRaw(): RawTotals {
  return {
    ledgerRows: 0,
    costUsd: '0',
    inputTokens: '0',
    outputTokens: '0',
    cacheWriteTokens: '0',
    cacheReadTokens: '0',
  };
}
