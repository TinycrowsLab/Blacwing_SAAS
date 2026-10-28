import { describe, expect, it } from 'vitest';

import {
  assertWithinBudgets,
  buildSloReport,
  findBreaches,
  KILL_EGRESS_P99_BUDGET_MS,
  KILL_FULL_HALT_P99_BUDGET_MS,
  KillSloBudgetError,
  percentile,
  summariseLatencies,
} from './slo.js';

const ascending = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('percentile (nearest rank)', () => {
  it('picks the ceil(p/100 * n)-th smallest sample', () => {
    const sample = ascending(100);
    expect(percentile(sample, 50)).toBe(50);
    expect(percentile(sample, 95)).toBe(95);
    expect(percentile(sample, 99)).toBe(99);
    expect(percentile(sample, 100)).toBe(100);
  });

  it('returns the only sample for a single-element sample at every rank', () => {
    expect(percentile([7], 1)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  it('rejects an empty sample and an out-of-range rank', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 100.5)).toThrow(RangeError);
    expect(() => percentile([1], Number.NaN)).toThrow(RangeError);
  });
});

describe('summariseLatencies', () => {
  it('sorts the input and reports p50/p95/p99/max', () => {
    const summary = summariseLatencies([30, 10, 20]);
    expect(summary).toEqual({ count: 3, p50Ms: 20, p95Ms: 30, p99Ms: 30, maxMs: 30 });
  });

  it('refuses an empty sample so a scenario that measured nothing cannot pass', () => {
    expect(() => summariseLatencies([])).toThrow(RangeError);
  });

  it('refuses negative, NaN and infinite samples (clock or measurement errors)', () => {
    expect(() => summariseLatencies([-1])).toThrow(RangeError);
    expect(() => summariseLatencies([Number.NaN])).toThrow(RangeError);
    expect(() => summariseLatencies([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});

describe('findBreaches', () => {
  const within = summariseLatencies([100, 200]);

  it('breaches when the egress p99 reaches the 2 s budget (the target is strict)', () => {
    const latency = {
      egress_block: summariseLatencies([KILL_EGRESS_P99_BUDGET_MS]),
      full_halt: within,
    };
    expect(findBreaches(latency)).toEqual([
      {
        metric: 'egress_block',
        p99Ms: KILL_EGRESS_P99_BUDGET_MS,
        budgetMs: KILL_EGRESS_P99_BUDGET_MS,
      },
    ]);
  });

  it('does not breach just below the budget', () => {
    const latency = {
      egress_block: summariseLatencies([KILL_EGRESS_P99_BUDGET_MS - 1]),
      full_halt: within,
    };
    expect(findBreaches(latency)).toEqual([]);
  });

  it('breaches the full-halt budget independently of egress', () => {
    const latency = {
      egress_block: within,
      full_halt: summariseLatencies([KILL_FULL_HALT_P99_BUDGET_MS + 1]),
    };
    expect(findBreaches(latency).map((b) => b.metric)).toEqual(['full_halt']);
  });
});

describe('buildSloReport and assertWithinBudgets', () => {
  const base = {
    mode: 'mock' as const,
    runs: 2,
    generatedAt: '2026-01-01T00:00:00.000Z',
    egressSamplesMs: [5, 6, 7],
    haltSamplesMs: [40, 50, 60],
  };

  it('passes when every kill halted and no budget is breached', () => {
    const report = buildSloReport({ ...base, killStatuses: { halted: 3 } });
    expect(report.pass).toBe(true);
    expect(report.killsFired).toBe(3);
    expect(report.latency.egress_block.p50Ms).toBe(6);
    expect(() => {
      assertWithinBudgets(report);
    }).not.toThrow();
  });

  it('fails the report when any kill is not halted, even inside the budgets', () => {
    const report = buildSloReport({ ...base, killStatuses: { halted: 2, partially_halted: 1 } });
    expect(report.breaches).toEqual([]);
    expect(report.pass).toBe(false);
  });

  it('fails the report when no kill fired at all', () => {
    expect(buildSloReport({ ...base, killStatuses: {} }).pass).toBe(false);
  });

  it('names every breach in the thrown error, so the CI log says what broke', () => {
    const report = buildSloReport({
      ...base,
      killStatuses: { halted: 1 },
      egressSamplesMs: [KILL_EGRESS_P99_BUDGET_MS + 500],
      haltSamplesMs: [KILL_FULL_HALT_P99_BUDGET_MS + 1],
    });
    expect(report.pass).toBe(false);
    let caught: unknown;
    try {
      assertWithinBudgets(report);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KillSloBudgetError);
    expect((caught as Error).message).toContain(
      `egress_block p99 ${String(KILL_EGRESS_P99_BUDGET_MS + 500)} ms >= budget ${String(KILL_EGRESS_P99_BUDGET_MS)} ms`,
    );
    expect((caught as Error).message).toContain('full_halt p99');
  });
});
