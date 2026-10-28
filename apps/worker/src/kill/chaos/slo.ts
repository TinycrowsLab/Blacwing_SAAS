// Pure SLO arithmetic for the kill chaos suite (KILL-008, §8.5). No I/O, so the budget logic is unit-tested.

/** §8.5: egress block p99 must stay below 2 s. */
export const KILL_EGRESS_P99_BUDGET_MS = 2_000;
/** §8.5: full halt p99 must stay below 10 s. */
export const KILL_FULL_HALT_P99_BUDGET_MS = 10_000;

const PERCENT_SCALE = 100;
const P50 = 50;
const P95 = 95;
const P99 = 99;

export type SloMetric = 'egress_block' | 'full_halt';

export interface SloBudget {
  readonly metric: SloMetric;
  readonly p99BudgetMs: number;
}

const KILL_SLO_BUDGETS: readonly SloBudget[] = [
  { metric: 'egress_block', p99BudgetMs: KILL_EGRESS_P99_BUDGET_MS },
  { metric: 'full_halt', p99BudgetMs: KILL_FULL_HALT_P99_BUDGET_MS },
];

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface SloBreach {
  readonly metric: SloMetric;
  readonly p99Ms: number;
  readonly budgetMs: number;
}

export interface KillSloReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly mode: 'mock' | 'real';
  readonly runs: number;
  readonly killsFired: number;
  /** Count of kill events per final status, for example `{ halted: 29 }`. */
  readonly killStatuses: Readonly<Record<string, number>>;
  readonly latency: Readonly<Record<SloMetric, LatencySummary>>;
  readonly budgets: readonly SloBudget[];
  readonly breaches: readonly SloBreach[];
  /** True only when no budget is breached and every kill ended `halted`. */
  readonly pass: boolean;
}

/** Thrown when a budget is breached; the message names every breach so the CI log is self-explanatory. */
export class KillSloBudgetError extends Error {
  constructor(readonly breaches: readonly SloBreach[]) {
    super(
      `kill SLO budget breached: ${breaches
        .map((b) => `${b.metric} p99 ${String(b.p99Ms)} ms >= budget ${String(b.budgetMs)} ms`)
        .join('; ')}`,
    );
    this.name = 'KillSloBudgetError';
  }
}

/** Nearest-rank percentile over an ascending, non-empty sample. `p` is in (0, 100]. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) throw new RangeError('percentile of an empty sample');
  if (!(p > 0 && p <= PERCENT_SCALE)) throw new RangeError('percentile must be in (0, 100]');
  const rank = Math.min(
    sortedAsc.length,
    Math.max(1, Math.ceil((p / PERCENT_SCALE) * sortedAsc.length)),
  );
  const value = sortedAsc[rank - 1];
  if (value === undefined) throw new RangeError('percentile rank outside the sample');
  return value;
}

/** p50/p95/p99/max over server-measured latencies. An empty or non-finite sample is an error, never a pass. */
export function summariseLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0)
    throw new RangeError('no latency samples: the scenario measured nothing');
  if (samples.some((ms) => !Number.isFinite(ms) || ms < 0)) {
    throw new RangeError('latency samples must be finite and non-negative');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, P50),
    p95Ms: percentile(sorted, P95),
    p99Ms: percentile(sorted, P99),
    maxMs: percentile(sorted, PERCENT_SCALE),
  };
}

/** A budget is breached when its p99 reaches the limit (the §8.5 targets are strict upper bounds). */
export function findBreaches(
  latency: Readonly<Record<SloMetric, LatencySummary>>,
  budgets: readonly SloBudget[] = KILL_SLO_BUDGETS,
): SloBreach[] {
  return budgets.flatMap((budget) => {
    const p99Ms = latency[budget.metric].p99Ms;
    return p99Ms >= budget.p99BudgetMs
      ? [{ metric: budget.metric, p99Ms, budgetMs: budget.p99BudgetMs }]
      : [];
  });
}

export interface BuildReportInput {
  readonly mode: 'mock' | 'real';
  readonly runs: number;
  readonly killStatuses: Readonly<Record<string, number>>;
  readonly egressSamplesMs: readonly number[];
  readonly haltSamplesMs: readonly number[];
  readonly generatedAt: string;
}

/** Builds the JSON SLO report. `pass` requires no breach and every fired kill to have ended `halted`. */
export function buildSloReport(input: BuildReportInput): KillSloReport {
  const latency = {
    egress_block: summariseLatencies(input.egressSamplesMs),
    full_halt: summariseLatencies(input.haltSamplesMs),
  } satisfies Record<SloMetric, LatencySummary>;
  const killsFired = Object.values(input.killStatuses).reduce((sum, n) => sum + n, 0);
  const breaches = findBreaches(latency);
  const allHalted = (input.killStatuses.halted ?? 0) === killsFired && killsFired > 0;
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    mode: input.mode,
    runs: input.runs,
    killsFired,
    killStatuses: input.killStatuses,
    latency,
    budgets: KILL_SLO_BUDGETS,
    breaches,
    pass: breaches.length === 0 && allHalted,
  };
}

/** Fails the caller when the report breaches a budget. The thrown error lists every breach. */
export function assertWithinBudgets(report: KillSloReport): void {
  if (report.breaches.length > 0) throw new KillSloBudgetError(report.breaches);
}
