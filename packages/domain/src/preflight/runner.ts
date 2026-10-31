import { AppError } from '@blackwing/errors';

import {
  dryRunDefinitions,
  PREFLIGHT_CATALOGUE,
  type PreflightCheckDefinition,
  type PreflightCheckId,
} from './catalogue.js';

/**
 * Preflight runner (#579). Executes a registry of checks against a context and aggregates one report.
 *
 * Every check runs, even after another one fails, so the operator sees every problem at once. A check
 * that throws, or never settles, becomes a `fail` with a stable code; it never aborts the report. The
 * error message of a thrown check is withheld from the result, because it can carry internal detail.
 * Results are ordered by check id so the report is deterministic.
 *
 * The run-time phase (ORCH-003, `apps/worker/src/run/preflight`) keeps its own staged executor that
 * cancels siblings on the first hard fail. This runner is the dry-run and read-only surface, which
 * deliberately does not short-circuit.
 */

export const PREFLIGHT_STATUSES = ['pass', 'fail', 'skip'] as const;
export type PreflightStatus = (typeof PREFLIGHT_STATUSES)[number];

/** Stable codes the runner itself emits. Check implementations may emit their own on `fail`. */
export const PREFLIGHT_RUNNER_CODES = Object.freeze({
  CHECK_THREW: 'PREFLIGHT_CHECK_ERROR',
  CHECK_TIMED_OUT: 'PREFLIGHT_CHECK_TIMEOUT',
  RESULT_MISMATCH: 'PREFLIGHT_RESULT_MISMATCH',
});

export const PREFLIGHT_DEFAULT_CONCURRENCY = 4;
/** Backstop for a check that never settles. A check that calls a slow service sets its own shorter timeout. */
export const PREFLIGHT_DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** Scalar evidence only: a check cannot attach a nested object that might carry a secret by accident. */
export type PreflightEvidence = Readonly<Record<string, string | number | boolean | null>>;

/** One check's answer. `detail` is operator-readable and never carries a secret (§8.7). */
export interface PreflightResult {
  readonly id: PreflightCheckId;
  readonly status: PreflightStatus;
  readonly detail: string;
  /** Stable failure code, set on `fail` (and on a `skip` that records why it did not run). */
  readonly code?: string;
  readonly evidence?: PreflightEvidence;
}

/**
 * A registered check. Its title and severity come from the catalogue entry with the same id, so the
 * definition exists in one place only.
 */
export interface PreflightCheck<Ctx> {
  readonly id: PreflightCheckId;
  run(ctx: Ctx): Promise<PreflightResult>;
}

export interface PreflightReport {
  /** True when no `blocking` check failed. A failing `warning` check does not change it. */
  readonly ok: boolean;
  /** Every result, ordered by check id. */
  readonly results: readonly PreflightResult[];
  /** Ids of the failing `blocking` checks, ordered by id. */
  readonly blockingFailures: readonly PreflightCheckId[];
}

export interface RunPreflightOptions {
  /** Catalogue entries the registry must match. Defaults to {@link PREFLIGHT_CATALOGUE}. */
  readonly definitions?: readonly PreflightCheckDefinition[];
  /** Maximum checks in flight at once. */
  readonly concurrency?: number;
  /** Per-check backstop timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** A registry that does not match its catalogue. This is a wiring error, so it throws instead of reporting. */
export class PreflightConfigError extends AppError {
  constructor(message: string) {
    super('INTERNAL', message);
  }
}

function failure(id: PreflightCheckId, code: string, detail: string): PreflightResult {
  return { id, status: 'fail', code, detail };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new PreflightConfigError(`${name} must be a positive integer`);
  }
}

/**
 * Checks the registry against the catalogue: every check id is known, none appears twice, and every id
 * in `required` is registered. Missing a required check would otherwise let `ok` pass silently.
 */
function assertRegistry<Ctx>(
  checks: readonly PreflightCheck<Ctx>[],
  definitions: readonly PreflightCheckDefinition[],
  required: readonly PreflightCheckId[],
): void {
  const known = new Set(definitions.map((definition) => definition.id));
  const registered = new Set<PreflightCheckId>();
  for (const check of checks) {
    if (!known.has(check.id)) {
      throw new PreflightConfigError(`preflight check ${check.id} is not in the catalogue`);
    }
    if (registered.has(check.id)) {
      throw new PreflightConfigError(`preflight check ${check.id} is registered twice`);
    }
    registered.add(check.id);
  }
  const missing = required.filter((id) => !registered.has(id));
  if (missing.length > 0) {
    throw new PreflightConfigError(`preflight checks are not registered: ${missing.join(', ')}`);
  }
}

/** Runs one check. A throw, a timeout or a mismatched id each become a `fail`, never a rejection. */
async function runOne<Ctx>(
  check: PreflightCheck<Ctx>,
  ctx: Ctx,
  timeoutMs: number,
): Promise<PreflightResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PreflightResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        failure(
          check.id,
          PREFLIGHT_RUNNER_CODES.CHECK_TIMED_OUT,
          `${check.id} did not finish within ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
  });
  try {
    // `Promise.race` subscribes to the check too, so a rejection after the timeout is handled, not unhandled.
    const result = await Promise.race([Promise.resolve().then(() => check.run(ctx)), timedOut]);
    if (result.id !== check.id) {
      return failure(
        check.id,
        PREFLIGHT_RUNNER_CODES.RESULT_MISMATCH,
        `${check.id} returned a result for another check`,
      );
    }
    return result;
  } catch {
    return failure(
      check.id,
      PREFLIGHT_RUNNER_CODES.CHECK_THREW,
      `${check.id} failed unexpectedly; details are withheld`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function compareIds(a: PreflightCheckId, b: PreflightCheckId): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Runs every check in the registry with a bounded pool and aggregates the report. Throws
 * {@link PreflightConfigError} when the registry does not match the catalogue.
 */
export async function runPreflight<Ctx>(
  checks: readonly PreflightCheck<Ctx>[],
  ctx: Ctx,
  options: RunPreflightOptions = {},
): Promise<PreflightReport> {
  const definitions = options.definitions ?? PREFLIGHT_CATALOGUE;
  const concurrency = options.concurrency ?? PREFLIGHT_DEFAULT_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_DEFAULT_CHECK_TIMEOUT_MS;
  assertPositiveInteger('concurrency', concurrency);
  assertPositiveInteger('timeoutMs', timeoutMs);
  assertRegistry(
    checks,
    definitions,
    definitions.map((definition) => definition.id),
  );

  const severityById = new Map(
    definitions.map((definition) => [definition.id, definition.severity]),
  );
  const queue = [...checks];
  const results: PreflightResult[] = [];
  const lanes = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let check = queue.shift(); check !== undefined; check = queue.shift()) {
      results.push(await runOne(check, ctx, timeoutMs));
    }
  });
  await Promise.all(lanes);

  const ordered = [...results].sort((a, b) => compareIds(a.id, b.id));
  const blockingFailures = ordered
    .filter((result) => result.status === 'fail' && severityById.get(result.id) === 'blocking')
    .map((result) => result.id);
  return { ok: blockingFailures.length === 0, results: ordered, blockingFailures };
}

/**
 * The pre-submit dry run: runs only the checks the catalogue marks read-only. A registry entry that is
 * not read-only (login, SOC notice) is dropped before anything executes, so the dry run cannot log in,
 * notify or send target traffic even when the full registry is wired in. Throws when a read-only check is
 * not registered.
 */
export async function runDryRunPreflight<Ctx>(
  checks: readonly PreflightCheck<Ctx>[],
  ctx: Ctx,
  options: RunPreflightOptions = {},
): Promise<PreflightReport> {
  const definitions = options.definitions ?? PREFLIGHT_CATALOGUE;
  const readOnly = dryRunDefinitions(definitions);
  assertRegistry(
    checks,
    definitions,
    readOnly.map((definition) => definition.id),
  );
  const readOnlyIds = new Set(readOnly.map((definition) => definition.id));
  const subset = checks.filter((check) => readOnlyIds.has(check.id));
  return runPreflight(subset, ctx, { ...options, definitions: readOnly });
}
