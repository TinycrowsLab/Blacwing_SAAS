import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { runBudgetsSchema } from './entities/authorisation.js';
import { testCaseBudgetSchema } from './entities/test-case.js';
import {
  assertWithinSaDefaults,
  BUDGET_CEILINGS,
  type BudgetCeiling,
  BudgetError,
  type BudgetErrorCode,
  checkTestCaseBudgetsAgainstRun,
  DEFAULT_REQUEST_BUDGETS,
  defaultBudgetForClass,
  type IntrusivenessClass,
  IntrusivenessError,
  isBudgetError,
  isIntrusivenessError,
  isWithinSaDefaults,
  parseBudgetDefaultsEnv,
  REQUEST_BUDGET_DIMENSIONS,
  type RequestBudget,
  requestBudgetSchema,
  resolveBudgetDefaults,
  resolveTestCaseBudget,
  RUN_BUDGET_DIMENSIONS,
  type RunBudget,
  validateBudget,
  validateRequestBudget,
  validateRunBudget,
} from './index.js';

const MIB = 1024 * 1024;

/** Runs `fn` and returns the `IntrusivenessError` code it throws (fails the test otherwise). */
function intrusivenessCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isIntrusivenessError(error)) return error.code;
  }
  throw new Error('expected an IntrusivenessError');
}

/** Runs `fn` and returns the `BudgetError` it throws (fails the test otherwise). */
function budgetErrorOf(fn: () => unknown): BudgetError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetError);
    expect(isBudgetError(error)).toBe(true);
    return error as BudgetError;
  }
  throw new Error('expected a BudgetError');
}

function codeOf(fn: () => unknown): BudgetErrorCode {
  return budgetErrorOf(fn).code;
}

const validRequest: RequestBudget = {
  maxRequests: 100,
  maxRps: 2,
  maxConcurrency: 1,
  maxBytes: 5_000_000,
};
/** Clamps a generated budget down until it satisfies the cross-field checks. */
function normalise(b: RequestBudget): RequestBudget {
  const maxRps = Math.min(b.maxRps, b.maxRequests);
  return {
    ...b,
    maxRps,
    maxConcurrency: Math.min(b.maxConcurrency, b.maxRequests, Math.max(1, Math.floor(maxRps * 60))),
  };
}

const validRun: RunBudget = { costCapUsd: 25, maxRequests: 5000, maxDurationMs: 7_200_000 };

describe('defaultBudgetForClass', () => {
  it('ships the explicit per-class constants', () => {
    expect(defaultBudgetForClass('passive')).toEqual({
      maxRequests: 200,
      maxRps: 5,
      maxConcurrency: 2,
      maxBytes: 50 * MIB,
    });
    expect(defaultBudgetForClass('active_safe')).toEqual({
      maxRequests: 2000,
      maxRps: 20,
      maxConcurrency: 5,
      maxBytes: 200 * MIB,
    });
    expect(defaultBudgetForClass('state_changing')).toEqual({
      maxRequests: 500,
      maxRps: 5,
      maxConcurrency: 2,
      maxBytes: 100 * MIB,
    });
  });

  it('is conservative by default: state_changing is no larger than active_safe on requests and RPS', () => {
    const sc = defaultBudgetForClass('state_changing');
    const as = defaultBudgetForClass('active_safe');
    expect(sc.maxRequests).toBeLessThanOrEqual(as.maxRequests);
    expect(sc.maxRps).toBeLessThanOrEqual(as.maxRps);
    expect(sc.maxConcurrency).toBeLessThanOrEqual(as.maxConcurrency);
  });

  it('every shipped default passes validation', () => {
    for (const b of Object.values(DEFAULT_REQUEST_BUDGETS)) {
      expect(validateRequestBudget(b)).toEqual(b);
    }
  });

  it('returns a copy, so callers cannot mutate the shipped constants', () => {
    const b = defaultBudgetForClass('passive');
    b.maxRequests = 1;
    expect(defaultBudgetForClass('passive').maxRequests).toBe(200);
    expect(Object.isFrozen(DEFAULT_REQUEST_BUDGETS.passive)).toBe(true);
  });

  it('refuses destructive (never runs, §8.3) and unknown classes', () => {
    expect(() => defaultBudgetForClass('destructive')).toThrow(IntrusivenessError);
    expect(intrusivenessCodeOf(() => defaultBudgetForClass('destructive'))).toBe(
      'SCOPE_DESTRUCTIVE_FORBIDDEN',
    );
    expect(intrusivenessCodeOf(() => defaultBudgetForClass('Passive' as IntrusivenessClass))).toBe(
      'SCOPE_INVALID_CLASS',
    );
  });
});

describe('SCOPE_BUDGET_DEFAULTS override', () => {
  it('unset or blank keeps the shipped defaults', () => {
    expect(parseBudgetDefaultsEnv(undefined)).toEqual(DEFAULT_REQUEST_BUDGETS);
    expect(parseBudgetDefaultsEnv('  ')).toEqual(DEFAULT_REQUEST_BUDGETS);
  });

  it('edge: a missing dimension in an override is filled from the class default', () => {
    const defaults = parseBudgetDefaultsEnv('{"passive":{"maxRps":2},"state_changing":{}}');
    expect(defaults.passive).toEqual({ ...DEFAULT_REQUEST_BUDGETS.passive, maxRps: 2 });
    for (const d of REQUEST_BUDGET_DIMENSIONS) {
      expect(defaults.passive[d]).toBeDefined();
    }
    expect(defaults.state_changing).toEqual(DEFAULT_REQUEST_BUDGETS.state_changing);
    expect(defaultBudgetForClass('passive', defaults).maxRps).toBe(2);
    expect(defaultBudgetForClass('active_safe', defaults)).toEqual(
      DEFAULT_REQUEST_BUDGETS.active_safe,
    );
  });

  it('rejects malformed JSON, unknown classes/keys and invalid values', () => {
    expect(codeOf(() => parseBudgetDefaultsEnv('{'))).toBe('SCOPE_INVALID_BUDGET');
    expect(codeOf(() => resolveBudgetDefaults({ destructive: { maxRps: 1 } }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(codeOf(() => resolveBudgetDefaults({ passive: { maxRpm: 1 } }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(codeOf(() => resolveBudgetDefaults({ passive: { maxRequests: 0 } }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    // A merged result that breaks the cross-field checks is rejected as a whole.
    expect(codeOf(() => resolveBudgetDefaults({ passive: { maxRequests: 3 } }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(codeOf(() => resolveBudgetDefaults(null))).toBe('SCOPE_INVALID_BUDGET');
  });
});

describe('validateBudget', () => {
  it('accepts valid request and run budgets', () => {
    expect(validateBudget(validRequest)).toEqual(validRequest);
    expect(validateBudget(validRun)).toEqual(validRun);
  });

  it.each([Infinity, -Infinity, 0, -1, Number.NaN])(
    'rejects %s on every request dimension',
    (bad) => {
      for (const d of REQUEST_BUDGET_DIMENSIONS) {
        const error = budgetErrorOf(() => validateBudget({ ...validRequest, [d]: bad }));
        expect(error.code).toBe('SCOPE_INVALID_BUDGET');
        expect(error.dimensions).toContain(d);
      }
    },
  );

  it.each([Infinity, 0, -1, Number.NaN])('rejects %s on every run dimension', (bad) => {
    for (const d of RUN_BUDGET_DIMENSIONS) {
      expect(codeOf(() => validateRunBudget({ ...validRun, [d]: bad }))).toBe(
        'SCOPE_INVALID_BUDGET',
      );
    }
  });

  it('edge: a cost cap of 0 or negative is rejected', () => {
    expect(codeOf(() => validateBudget({ ...validRun, costCapUsd: 0 }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(codeOf(() => validateBudget({ ...validRun, costCapUsd: -0.01 }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
  });

  it('edge: overflow beyond the safe integer range is rejected', () => {
    for (const d of ['maxRequests', 'maxConcurrency', 'maxBytes'] as const) {
      for (const huge of [Number.MAX_SAFE_INTEGER + 2, 2 ** 64, Number.MAX_VALUE]) {
        expect(codeOf(() => validateRequestBudget({ ...validRequest, [d]: huge }))).toBe(
          'SCOPE_INVALID_BUDGET',
        );
      }
    }
    expect(codeOf(() => validateRunBudget({ ...validRun, maxDurationMs: 2 ** 60 }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
  });

  it('rejects values above the absolute sanity ceilings', () => {
    expect(
      codeOf(() =>
        validateRequestBudget({ ...validRequest, maxRequests: BUDGET_CEILINGS.maxRequests + 1 }),
      ),
    ).toBe('SCOPE_INVALID_BUDGET');
    expect(
      codeOf(() => validateRunBudget({ ...validRun, costCapUsd: BUDGET_CEILINGS.costCapUsd + 1 })),
    ).toBe('SCOPE_INVALID_BUDGET');
  });

  it('rejects fractions on integer dimensions, non-numbers, missing and unknown keys', () => {
    expect(codeOf(() => validateRequestBudget({ ...validRequest, maxRequests: 1.5 }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(codeOf(() => validateRequestBudget({ ...validRequest, maxBytes: '100' }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    const missing = { maxRequests: 1, maxRps: 1, maxConcurrency: 1 };
    expect(codeOf(() => validateRequestBudget(missing))).toBe('SCOPE_INVALID_BUDGET');
    expect(codeOf(() => validateRequestBudget({ ...validRequest, unlimited: true }))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(codeOf(() => validateBudget(null))).toBe('SCOPE_INVALID_BUDGET');
  });

  it('rejects absurd cross-field combinations', () => {
    // A rate above the total request count.
    expect(
      codeOf(() => validateRequestBudget({ ...validRequest, maxRequests: 10, maxRps: 11 })),
    ).toBe('SCOPE_INVALID_BUDGET');
    // More requests in flight than the total.
    expect(
      codeOf(() =>
        validateRequestBudget({ ...validRequest, maxRequests: 10, maxRps: 5, maxConcurrency: 11 }),
      ),
    ).toBe('SCOPE_INVALID_BUDGET');
    // More in flight than the rate could start within the window.
    expect(
      codeOf(() =>
        validateRequestBudget({
          ...validRequest,
          maxRequests: 10_000,
          maxRps: 1,
          maxConcurrency: 61,
        }),
      ),
    ).toBe('SCOPE_INVALID_BUDGET');
  });

  it('edge: floating-point RPS below 1 is allowed', () => {
    expect(validateRequestBudget({ ...validRequest, maxRps: 0.5 }).maxRps).toBe(0.5);
    expect(
      validateRequestBudget({ ...validRequest, maxRps: 0.001, maxConcurrency: 1 }).maxRps,
    ).toBe(0.001);
  });

  it('does not echo untrusted values in the message', () => {
    const error = budgetErrorOf(() =>
      validateRequestBudget({ ...validRequest, maxRequests: 'secret-ish' }),
    );
    expect(error.message).not.toContain('secret-ish');
  });

  it('the entity contracts share the same schemas', () => {
    expect(testCaseBudgetSchema).toBe(requestBudgetSchema);
    expect(runBudgetsSchema.safeParse({ ...validRun, costCapUsd: 0 }).success).toBe(false);
    expect(testCaseBudgetSchema.safeParse({ ...validRequest, maxRps: Infinity }).success).toBe(
      false,
    );
  });
});

describe('assertWithinSaDefaults', () => {
  const sa: BudgetCeiling = { ...validRequest, costCapUsd: 25, maxDurationMs: 7_200_000 };

  it('accepts a request at or below the SA on every dimension', () => {
    expect(() => {
      assertWithinSaDefaults(validRequest, sa);
    }).not.toThrow();
    expect(() => {
      assertWithinSaDefaults({ ...validRequest, maxRps: 1 }, sa);
    }).not.toThrow();
    expect(isWithinSaDefaults(validRun, { ...validRun })).toBe(true);
  });

  it.each([
    'maxRequests',
    'maxRps',
    'maxConcurrency',
    'maxBytes',
    'costCapUsd',
    'maxDurationMs',
  ] as const)('rejects a request exceeding the SA on %s', (d) => {
    const bound = sa[d] ?? 0;
    const error = budgetErrorOf(() => {
      assertWithinSaDefaults({ ...sa, [d]: bound + 1 }, sa);
    });
    expect(error.code).toBe('SCOPE_BUDGET_EXCEEDS_SA');
    expect(error.dimensions).toEqual([d]);
    expect(isWithinSaDefaults({ ...sa, [d]: bound + 1 }, sa)).toBe(false);
  });

  it('works against an SA whose default_budgets is a run budget', () => {
    expect(
      codeOf(() => {
        assertWithinSaDefaults({ ...validRequest, maxRequests: 5001 }, validRun);
      }),
    ).toBe('SCOPE_BUDGET_EXCEEDS_SA');
    expect(() => {
      assertWithinSaDefaults(validRequest, validRun);
    }).not.toThrow();
  });

  it('fails closed on NaN/Infinity requested values and invalid SA bounds', () => {
    expect(
      codeOf(() => {
        assertWithinSaDefaults({ maxRequests: Number.NaN }, sa);
      }),
    ).toBe('SCOPE_BUDGET_EXCEEDS_SA');
    expect(
      codeOf(() => {
        assertWithinSaDefaults({ maxRequests: Infinity }, sa);
      }),
    ).toBe('SCOPE_BUDGET_EXCEEDS_SA');
    expect(
      codeOf(() => {
        assertWithinSaDefaults(validRequest, { maxRequests: Infinity });
      }),
    ).toBe('SCOPE_INVALID_BUDGET');
    expect(
      codeOf(() => {
        assertWithinSaDefaults(validRequest, { maxRps: 0 });
      }),
    ).toBe('SCOPE_INVALID_BUDGET');
  });
});

describe('resolveTestCaseBudget', () => {
  it('returns the per-dimension minimum (most restrictive wins)', () => {
    const sa: BudgetCeiling = {
      maxRequests: 1000,
      maxRps: 10,
      maxConcurrency: 4,
      maxBytes: 3_000_000,
    };
    const request: BudgetCeiling = {
      maxRequests: 50,
      maxRps: 20,
      maxConcurrency: 1,
      maxBytes: 9_000_000,
    };
    const testCase: RequestBudget = {
      maxRequests: 200,
      maxRps: 1.5,
      maxConcurrency: 8,
      maxBytes: 10_000_000,
    };
    expect(resolveTestCaseBudget(sa, request, testCase)).toEqual({
      maxRequests: 50,
      maxRps: 1.5,
      maxConcurrency: 1,
      maxBytes: 3_000_000,
    });
  });

  it('treats missing dimensions at the SA/request level as unbounded there', () => {
    expect(resolveTestCaseBudget(validRun, {}, validRequest)).toEqual(validRequest);
    expect(resolveTestCaseBudget({ maxRequests: 40 }, {}, validRequest).maxRequests).toBe(40);
  });

  it('clamps the minimum down so it stays self-consistent', () => {
    const result = resolveTestCaseBudget(
      { maxRequests: 3 },
      {},
      {
        maxRequests: 100,
        maxRps: 20,
        maxConcurrency: 5,
        maxBytes: 1000,
      },
    );
    expect(result).toEqual({ maxRequests: 3, maxRps: 3, maxConcurrency: 3, maxBytes: 1000 });
  });

  it('rejects invalid bounds instead of ignoring them', () => {
    expect(codeOf(() => resolveTestCaseBudget({ maxRps: Number.NaN }, {}, validRequest))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(codeOf(() => resolveTestCaseBudget({}, { maxBytes: -1 }, validRequest))).toBe(
      'SCOPE_INVALID_BUDGET',
    );
    expect(
      codeOf(() => resolveTestCaseBudget({}, {}, { ...validRequest, maxRequests: Infinity })),
    ).toBe('SCOPE_INVALID_BUDGET');
  });

  it('property: is monotone (tightening any input never loosens the output)', () => {
    const intIn = (max: number) => fc.integer({ min: 1, max });
    const budgetArb = fc
      .record({
        maxRequests: intIn(100_000),
        maxRps: fc.double({ min: 0.01, max: 1000, noNaN: true }),
        maxConcurrency: intIn(256),
        maxBytes: intIn(1_000_000_000),
      })
      .map((b) => normalise(b));
    const ceilingArb = fc.record(
      {
        maxRequests: intIn(100_000),
        maxRps: fc.double({ min: 0.01, max: 1000, noNaN: true }),
        maxConcurrency: intIn(256),
        maxBytes: intIn(1_000_000_000),
      },
      { requiredKeys: [] },
    );
    const dimArb = fc.constantFrom(...REQUEST_BUDGET_DIMENSIONS);
    fc.assert(
      fc.property(
        ceilingArb,
        ceilingArb,
        budgetArb,
        fc.integer({ min: 0, max: 2 }),
        dimArb,
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        (sa, request, testCase, which, dim, factor) => {
          const before = resolveTestCaseBudget(sa, request, testCase);
          const tighten = (level: BudgetCeiling, base: number): BudgetCeiling => {
            const current = level[dim] ?? base;
            const next =
              dim === 'maxRps' ? current * factor : Math.max(1, Math.floor(current * factor));
            return { ...level, [dim]: next };
          };
          let after: RequestBudget;
          if (which === 0)
            after = resolveTestCaseBudget(tighten(sa, testCase[dim]), request, testCase);
          else if (which === 1)
            after = resolveTestCaseBudget(sa, tighten(request, testCase[dim]), testCase);
          else
            after = resolveTestCaseBudget(
              sa,
              request,
              normalise({ ...testCase, ...(tighten({}, testCase[dim]) as Partial<RequestBudget>) }),
            );
          for (const d of REQUEST_BUDGET_DIMENSIONS) {
            expect(after[d]).toBeLessThanOrEqual(before[d]);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('checkTestCaseBudgetsAgainstRun', () => {
  it('passes when the sum of test-case requests fits the run total', () => {
    const check = checkTestCaseBudgetsAgainstRun(
      [{ maxRequests: 2000 }, { maxRequests: 3000 }],
      validRun,
    );
    expect(check).toEqual({
      withinRun: true,
      totalRequests: 5000,
      runMaxRequests: 5000,
      oversizedIndexes: [],
    });
  });

  it('edge: flags a request budget larger than the run maxRequests at submit', () => {
    const check = checkTestCaseBudgetsAgainstRun(
      [{ maxRequests: 10 }, { maxRequests: 6000 }],
      validRun,
    );
    expect(check.withinRun).toBe(false);
    expect(check.oversizedIndexes).toEqual([1]);
  });

  it('flags a sum above the run total even when each budget fits alone', () => {
    const check = checkTestCaseBudgetsAgainstRun(
      [{ maxRequests: 3000 }, { maxRequests: 3000 }],
      validRun,
    );
    expect(check.withinRun).toBe(false);
    expect(check.totalRequests).toBe(6000);
    expect(check.oversizedIndexes).toEqual([]);
  });
});
