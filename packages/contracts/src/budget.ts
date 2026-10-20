import { z } from 'zod';

import {
  type IntrusivenessClass,
  IntrusivenessError,
  isSelectable,
  parseIntrusivenessClass,
} from './intrusiveness.js';
import { LIMITS } from './limits.js';

/**
 * Request-budget model (SCOPE-004, CONTEXT_PACK §2 F5 / §7): the caps attached to assessment
 * requests, standing authorisations (`default_budgets`), runs and test cases.
 *
 * This module is the model, the shipped defaults and the validation only. Runtime enforcement is
 * the egress gateway (per test case, EGRESS-010) and the model gateway / cost tracker (cost caps,
 * GATEWAY-011). Everything here is pure and deterministic (§8.11).
 *
 * Units:
 * - `maxRequests`: count of HTTP requests (or protocol exchanges) the gateway lets through.
 * - `maxRps`: requests per second, a real number. Sub-1 values (e.g. `0.5`) are allowed; the
 *   gateway implements them with a token bucket (EGRESS-010).
 * - `maxConcurrency`: requests in flight at the same time.
 * - `maxBytes`: request + response bytes, as counted by the egress gateway.
 * - `costCapUsd`: a cap in US dollars. The price is taken from the price-table version pinned on
 *   the run (§8.9); this model carries the cap, never the price.
 * - `maxDurationMs`: wall-clock duration of the run in milliseconds.
 *
 * Relationship between a run and its test cases: the run's `maxRequests` bounds the SUM of the
 * test-case `maxRequests`. A single test-case (or request) budget above the run total is flagged at
 * submit time by {@link checkTestCaseBudgetsAgainstRun}; strict enforcement is EGRESS/GATEWAY.
 */

/** Stable machine codes the budget helpers fail with; each is registered in `@blackwing/errors`. */
export const BUDGET_ERROR_CODES = ['SCOPE_INVALID_BUDGET', 'SCOPE_BUDGET_EXCEEDS_SA'] as const;
export type BudgetErrorCode = (typeof BUDGET_ERROR_CODES)[number];

/** Error thrown by the budget validators. `code` is a stable, registered error code. */
export class BudgetError extends Error {
  readonly code: BudgetErrorCode;
  /** The budget dimensions that caused the failure (never values: callers may log this). */
  readonly dimensions: readonly string[];

  constructor(code: BudgetErrorCode, message: string, dimensions: readonly string[] = []) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
    this.dimensions = Object.freeze([...dimensions]);
  }
}

/** True when `value` is a `BudgetError` (also across package copies). */
export function isBudgetError(value: unknown): value is BudgetError {
  return (
    value instanceof Error &&
    value.name === 'BudgetError' &&
    (BUDGET_ERROR_CODES as readonly unknown[]).includes((value as { code?: unknown }).code)
  );
}

/**
 * Absolute sanity ceilings. A budget above any of these is treated as a typo or an attempt to
 * disable the cap, and rejected with `SCOPE_INVALID_BUDGET`. They are deliberately far above any
 * shipped default; tightening is done through SA defaults, never by raising these.
 */
export const BUDGET_CEILINGS = Object.freeze({
  /** Requests per test case or per run. */
  maxRequests: 10_000_000,
  /** Requests per second. */
  maxRps: 1_000,
  /** Requests in flight. */
  maxConcurrency: 256,
  /** 1 TiB of request + response bytes. */
  maxBytes: 1_099_511_627_776,
  /** USD per run (shared with the entity contracts). */
  costCapUsd: LIMITS.costCapUsdMax,
  /** 30 days of wall-clock run time. */
  maxDurationMs: 2_592_000_000,
} as const);

/**
 * Window, in seconds, for the concurrency sanity check: `maxConcurrency <= maxRps * window`. With
 * typical request latencies far below this window, more requests in flight than the rate could
 * ever start within it cannot be used and indicates a mis-specified budget.
 */
export const BUDGET_CONCURRENCY_WINDOW_S = 60;

const invalid = (): string => 'SCOPE_INVALID_BUDGET';

/** A positive safe integer no larger than `max`. Rejects NaN, Infinity, 0, negatives, fractions. */
function positiveInt(max: number): z.ZodInt {
  return z.int({ error: invalid }).positive({ error: invalid }).max(max, { error: invalid });
}

/** A positive finite number no larger than `max`. Rejects NaN, Infinity, 0 and negatives. */
function positiveNumber(max: number): z.ZodNumber {
  return z.number({ error: invalid }).positive({ error: invalid }).max(max, { error: invalid });
}

const requestBudgetShape = {
  maxRequests: positiveInt(BUDGET_CEILINGS.maxRequests),
  maxRps: positiveNumber(BUDGET_CEILINGS.maxRps),
  maxConcurrency: positiveInt(BUDGET_CEILINGS.maxConcurrency),
  maxBytes: positiveInt(BUDGET_CEILINGS.maxBytes),
};

/**
 * Per-test-case / per-request traffic budget (§7 `test_cases.budget`). Cross-field sanity:
 * `maxRps <= maxRequests` (a rate above the total is meaningless), `maxConcurrency <= maxRequests`
 * and `maxConcurrency <= max(1, maxRps * BUDGET_CONCURRENCY_WINDOW_S)` (one request in flight is
 * always sane, so very low rates stay valid).
 */
export const requestBudgetSchema = z.strictObject(requestBudgetShape).superRefine((b, ctx) => {
  if (b.maxRps > b.maxRequests) {
    ctx.addIssue({ code: 'custom', message: 'SCOPE_INVALID_BUDGET', path: ['maxRps'] });
  }
  if (b.maxConcurrency > b.maxRequests) {
    ctx.addIssue({ code: 'custom', message: 'SCOPE_INVALID_BUDGET', path: ['maxConcurrency'] });
  }
  if (b.maxConcurrency > Math.max(1, b.maxRps * BUDGET_CONCURRENCY_WINDOW_S)) {
    ctx.addIssue({ code: 'custom', message: 'SCOPE_INVALID_BUDGET', path: ['maxConcurrency'] });
  }
});
export type RequestBudget = z.infer<typeof requestBudgetSchema>;

/** One dimension of a {@link RequestBudget}. */
export type RequestBudgetDimension = keyof RequestBudget;
export const REQUEST_BUDGET_DIMENSIONS = Object.freeze([
  'maxRequests',
  'maxRps',
  'maxConcurrency',
  'maxBytes',
] as const satisfies readonly RequestBudgetDimension[]);

/** Run budget (§7 `runs.budgets`, SA `default_budgets`): cost cap, request cap, wall-clock cap. */
export const runBudgetSchema = z.strictObject({
  costCapUsd: positiveNumber(BUDGET_CEILINGS.costCapUsd),
  maxRequests: positiveInt(BUDGET_CEILINGS.maxRequests),
  maxDurationMs: positiveInt(BUDGET_CEILINGS.maxDurationMs),
});
export type RunBudget = z.infer<typeof runBudgetSchema>;

/** One dimension of a {@link RunBudget}. */
export type RunBudgetDimension = keyof RunBudget;
export const RUN_BUDGET_DIMENSIONS = Object.freeze([
  'costCapUsd',
  'maxRequests',
  'maxDurationMs',
] as const satisfies readonly RunBudgetDimension[]);

/** Any budget dimension (request or run). */
export type BudgetDimension = RequestBudgetDimension | RunBudgetDimension;

/**
 * A set of upper bounds keyed by dimension. Absent dimensions are unbounded at this level. Used for
 * SA ceilings, which may carry request dimensions, run dimensions or both.
 */
export type BudgetCeiling = Partial<Record<BudgetDimension, number>>;

/**
 * Shipped per-class request-budget defaults. Explicit constants, never computed; the eval harness
 * (EVAL) may tune them later. Rationale:
 * - `passive`: observation only, so few requests at a low rate; 50 MiB covers page and asset fetches.
 * - `active_safe`: crafted read-only probing needs the most requests and the highest rate.
 * - `state_changing`: conservative. Every action is journalled and reversed (§3.5), so the request
 *   count and rate are kept at or below `active_safe` to limit blast radius.
 */
export const DEFAULT_PASSIVE_BUDGET: RequestBudget = Object.freeze({
  maxRequests: 200,
  maxRps: 5,
  maxConcurrency: 2,
  maxBytes: 52_428_800, // 50 MiB
});
export const DEFAULT_ACTIVE_SAFE_BUDGET: RequestBudget = Object.freeze({
  maxRequests: 2000,
  maxRps: 20,
  maxConcurrency: 5,
  maxBytes: 209_715_200, // 200 MiB
});
export const DEFAULT_STATE_CHANGING_BUDGET: RequestBudget = Object.freeze({
  maxRequests: 500,
  maxRps: 5,
  maxConcurrency: 2,
  maxBytes: 104_857_600, // 100 MiB
});

/** A class that may carry a budget: every selectable class (never `destructive`, §8.3). */
export type BudgetedIntrusivenessClass = Exclude<IntrusivenessClass, 'destructive'>;

/** Shipped defaults per selectable class. */
export const DEFAULT_REQUEST_BUDGETS: Readonly<Record<BudgetedIntrusivenessClass, RequestBudget>> =
  Object.freeze({
    passive: DEFAULT_PASSIVE_BUDGET,
    active_safe: DEFAULT_ACTIVE_SAFE_BUDGET,
    state_changing: DEFAULT_STATE_CHANGING_BUDGET,
  });

/** Partial per-class overrides, as carried by `SCOPE_BUDGET_DEFAULTS`. */
export type BudgetDefaultsOverride = Partial<
  Record<BudgetedIntrusivenessClass, Partial<RequestBudget>>
>;

/** Name of the environment variable that may override the shipped defaults (JSON). */
export const SCOPE_BUDGET_DEFAULTS_ENV = 'SCOPE_BUDGET_DEFAULTS';

const budgetDefaultsOverrideSchema = z.strictObject({
  passive: z.strictObject(requestBudgetShape).partial().optional(),
  active_safe: z.strictObject(requestBudgetShape).partial().optional(),
  state_changing: z.strictObject(requestBudgetShape).partial().optional(),
});

function throwInvalid(error: z.ZodError, fallbackMessage: string): never {
  const dimensions = [
    ...new Set(error.issues.map((i) => i.path.map(String).join('.')).filter(Boolean)),
  ];
  // Values are deliberately not echoed: budgets may come from untrusted input.
  throw new BudgetError(
    'SCOPE_INVALID_BUDGET',
    dimensions.length > 0 ? `Invalid budget: ${dimensions.join(', ')}` : fallbackMessage,
    dimensions,
  );
}

function budgetedClass(c: IntrusivenessClass): BudgetedIntrusivenessClass {
  const parsed = parseIntrusivenessClass(c);
  if (parsed === 'destructive' || !isSelectable(parsed)) {
    throw new IntrusivenessError(
      'SCOPE_DESTRUCTIVE_FORBIDDEN',
      'The destructive class never runs, so it has no budget',
    );
  }
  return parsed;
}

/**
 * Parses and validates an override object (the decoded `SCOPE_BUDGET_DEFAULTS`). Every dimension the
 * override leaves out is filled from the shipped class default, never left undefined, and each
 * resulting budget is validated as a whole.
 *
 * @throws {BudgetError} `SCOPE_INVALID_BUDGET` for unknown classes/keys or an invalid result.
 */
export function resolveBudgetDefaults(
  override: unknown = {},
): Readonly<Record<BudgetedIntrusivenessClass, RequestBudget>> {
  const parsed = budgetDefaultsOverrideSchema.safeParse(override);
  if (!parsed.success) throwInvalid(parsed.error, 'Invalid budget defaults override');
  const merged = {} as Record<BudgetedIntrusivenessClass, RequestBudget>;
  for (const c of Object.keys(DEFAULT_REQUEST_BUDGETS) as BudgetedIntrusivenessClass[]) {
    const partial = parsed.data[c] ?? {};
    const filled: RequestBudget = { ...DEFAULT_REQUEST_BUDGETS[c] };
    for (const d of REQUEST_BUDGET_DIMENSIONS) {
      const value = partial[d];
      if (value !== undefined) filled[d] = value;
    }
    merged[c] = Object.freeze(validateRequestBudget(filled));
  }
  return Object.freeze(merged);
}

/**
 * Parses the raw `SCOPE_BUDGET_DEFAULTS` environment value (JSON, e.g.
 * `{"passive":{"maxRps":2}}`). Unset or blank means the shipped defaults. Service config schemas call
 * this; this package does not read the environment itself.
 *
 * @throws {BudgetError} `SCOPE_INVALID_BUDGET` for malformed JSON or an invalid override.
 */
export function parseBudgetDefaultsEnv(
  raw: string | undefined,
): Readonly<Record<BudgetedIntrusivenessClass, RequestBudget>> {
  if (raw === undefined || raw.trim() === '') return resolveBudgetDefaults({});
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new BudgetError('SCOPE_INVALID_BUDGET', `${SCOPE_BUDGET_DEFAULTS_ENV} is not valid JSON`);
  }
  return resolveBudgetDefaults(decoded);
}

/**
 * Default request budget for an intrusiveness class. With `defaults` (from
 * {@link resolveBudgetDefaults} / {@link parseBudgetDefaultsEnv}) the configured values are used,
 * otherwise the shipped constants. Returns a fresh copy.
 *
 * @throws {IntrusivenessError} `SCOPE_INVALID_CLASS` for a non-canonical class;
 *   `SCOPE_DESTRUCTIVE_FORBIDDEN` for `destructive`, which never runs (§8.3).
 */
export function defaultBudgetForClass(
  c: IntrusivenessClass,
  defaults: Readonly<Record<BudgetedIntrusivenessClass, RequestBudget>> = DEFAULT_REQUEST_BUDGETS,
): RequestBudget {
  return { ...defaults[budgetedClass(c)] };
}

/**
 * Validates a request budget from untrusted input.
 * @throws {BudgetError} `SCOPE_INVALID_BUDGET` for missing, non-positive, NaN, Infinity, unsafe
 *   integer or out-of-ceiling values, and for the cross-field sanity checks.
 */
export function validateRequestBudget(b: unknown): RequestBudget {
  const parsed = requestBudgetSchema.safeParse(b);
  if (!parsed.success) throwInvalid(parsed.error, 'Invalid request budget');
  return parsed.data;
}

/**
 * Validates a run budget from untrusted input.
 * @throws {BudgetError} `SCOPE_INVALID_BUDGET`, including a cost cap of 0 or below.
 */
export function validateRunBudget(b: unknown): RunBudget {
  const parsed = runBudgetSchema.safeParse(b);
  if (!parsed.success) throwInvalid(parsed.error, 'Invalid run budget');
  return parsed.data;
}

/**
 * Validates a request budget or a run budget (a value carrying `costCapUsd` is a run budget).
 * @throws {BudgetError} `SCOPE_INVALID_BUDGET`.
 */
export function validateBudget(b: unknown): RequestBudget | RunBudget {
  if (typeof b === 'object' && b !== null && 'costCapUsd' in b) return validateRunBudget(b);
  return validateRequestBudget(b);
}

/** True when `n` is a usable bound: finite and positive. */
function isBound(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Asserts a requested budget does not exceed the SA's `default_budgets` on any dimension the SA
 * bounds. Fails closed: a requested dimension that is not a finite positive number while the SA
 * bounds it, or an SA bound that is not a finite positive number, is rejected.
 *
 * @throws {BudgetError} `SCOPE_BUDGET_EXCEEDS_SA` listing every exceeding dimension;
 *   `SCOPE_INVALID_BUDGET` for an invalid SA bound.
 */
export function assertWithinSaDefaults(requested: BudgetCeiling, saDefaults: BudgetCeiling): void {
  const exceeded: string[] = [];
  for (const [dimension, bound] of Object.entries(saDefaults)) {
    if (!isBound(bound)) {
      throw new BudgetError('SCOPE_INVALID_BUDGET', `Invalid SA budget: ${dimension}`, [dimension]);
    }
    const value = (requested as Record<string, unknown>)[dimension];
    if (value === undefined) continue;
    if (!isBound(value) || value > bound) exceeded.push(dimension);
  }
  if (exceeded.length > 0) {
    throw new BudgetError(
      'SCOPE_BUDGET_EXCEEDS_SA',
      `Requested budget exceeds the standing authorisation on: ${exceeded.join(', ')}`,
      exceeded,
    );
  }
}

/** Non-throwing form of {@link assertWithinSaDefaults}. */
export function isWithinSaDefaults(requested: BudgetCeiling, saDefaults: BudgetCeiling): boolean {
  try {
    assertWithinSaDefaults(requested, saDefaults);
    return true;
  } catch (error) {
    if (isBudgetError(error)) return false;
    throw error;
  }
}

/**
 * Effective budget of a test case: the per-dimension minimum of the SA defaults, the request's
 * budget and the test case's own budget (most restrictive wins). The SA and request levels may
 * leave dimensions out (unbounded at that level); the test case budget is complete. The minimum is
 * then clamped down to satisfy the cross-field checks and validated.
 *
 * @throws {BudgetError} `SCOPE_INVALID_BUDGET` if any input bound is invalid or the result fails
 *   validation.
 */
export function resolveTestCaseBudget(
  saDefaults: BudgetCeiling,
  requestBudget: BudgetCeiling,
  testCaseBudget: RequestBudget,
): RequestBudget {
  const base = validateRequestBudget(testCaseBudget);
  const out: RequestBudget = { ...base };
  for (const level of [saDefaults, requestBudget]) {
    for (const d of REQUEST_BUDGET_DIMENSIONS) {
      const bound = level[d];
      if (bound === undefined) continue;
      if (!isBound(bound)) {
        throw new BudgetError('SCOPE_INVALID_BUDGET', `Invalid budget bound: ${d}`, [d]);
      }
      out[d] = Math.min(out[d], bound);
    }
  }
  // Integer dimensions stay integers: a fractional upstream bound rounds down (more restrictive).
  out.maxRequests = Math.floor(out.maxRequests);
  out.maxConcurrency = Math.floor(out.maxConcurrency);
  out.maxBytes = Math.floor(out.maxBytes);
  // Keep the minimum self-consistent by clamping down (never up), so the cross-field checks hold
  // and tightening any input can only tighten the result.
  out.maxRps = Math.min(out.maxRps, out.maxRequests);
  out.maxConcurrency = Math.min(
    out.maxConcurrency,
    out.maxRequests,
    Math.max(1, Math.floor(out.maxRps * BUDGET_CONCURRENCY_WINDOW_S)),
  );
  return validateRequestBudget(out);
}

/** Result of {@link checkTestCaseBudgetsAgainstRun}. */
export interface RunBudgetCheck {
  /** True when the sum of test-case `maxRequests` fits the run's `maxRequests`. */
  readonly withinRun: boolean;
  /** Sum of the test-case `maxRequests`. */
  readonly totalRequests: number;
  /** The run's `maxRequests`. */
  readonly runMaxRequests: number;
  /** Indexes of test-case budgets that alone exceed the run's `maxRequests`. */
  readonly oversizedIndexes: readonly number[];
}

/**
 * Submit-time check of test-case (or request) budgets against the run total: the run's
 * `maxRequests` bounds the sum of the test-case budgets. Flags, does not throw; strict enforcement
 * is EGRESS-010 / GATEWAY-011.
 */
export function checkTestCaseBudgetsAgainstRun(
  budgets: readonly Pick<RequestBudget, 'maxRequests'>[],
  run: Pick<RunBudget, 'maxRequests'>,
): RunBudgetCheck {
  let total = 0;
  const oversized: number[] = [];
  budgets.forEach((b, i) => {
    total += b.maxRequests;
    if (b.maxRequests > run.maxRequests) oversized.push(i);
  });
  return Object.freeze({
    withinRun: total <= run.maxRequests,
    totalRequests: total,
    runMaxRequests: run.maxRequests,
    oversizedIndexes: Object.freeze(oversized),
  });
}
