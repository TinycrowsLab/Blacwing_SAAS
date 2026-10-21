import {
  GATE_CHECK_IDS,
  LIVE_CHECK_IDS,
  PREFLIGHT_CHECK_IDS,
  type PreflightCheckId,
  type PreflightCheckResult,
  type PreflightDecision,
  type PreflightReport,
} from './types.js';

// Pure aggregation for the preflight phase. Bundled into the workflow, so no Node built-ins.

/** Runs one check; rejects when the check could not complete (retries exhausted) or was cancelled. */
export type CheckRunner = (id: PreflightCheckId) => Promise<PreflightCheckResult>;

function unavailable(id: PreflightCheckId): PreflightCheckResult {
  const code =
    id === 'assertModelProviderReachable'
      ? 'MODEL_PROVIDER_UNREACHABLE'
      : id === 'deliverSocNotice'
        ? 'SOC_NOTICE_UNCONFIRMED'
        : 'CHECK_UNAVAILABLE';
  // The cause is deliberately not echoed: a downstream error message may carry internal detail.
  return {
    id,
    status: 'fail',
    code,
    detail: `${id} could not complete after retries`,
  };
}

/**
 * Executes the two stages and aggregates the report (ORCH-003). Gates run concurrently first; only when
 * all pass do the live checks run, also concurrently. The first hard fail calls `cancel` so in-flight
 * siblings stop; they are recorded as skipped, never as failed, so the first failure stays the cause.
 */
export async function executePreflight(
  run: CheckRunner,
  cancel: () => void,
): Promise<PreflightReport> {
  const results = new Map<PreflightCheckId, PreflightCheckResult>();
  const state = { cancelled: false };

  const runOne = async (id: PreflightCheckId): Promise<void> => {
    let result: PreflightCheckResult;
    try {
      result = await run(id);
    } catch {
      result = state.cancelled
        ? {
            id,
            status: 'skip',
            code: 'CHECK_CANCELLED',
            detail: 'cancelled after another check failed',
          }
        : unavailable(id);
    }
    results.set(id, result);
    if (result.status === 'fail' && !state.cancelled) {
      state.cancelled = true;
      cancel();
    }
  };

  await Promise.all(GATE_CHECK_IDS.map((id) => runOne(id)));
  if (!state.cancelled) await Promise.all(LIVE_CHECK_IDS.map((id) => runOne(id)));

  const checks = PREFLIGHT_CHECK_IDS.map(
    (id): PreflightCheckResult =>
      results.get(id) ?? {
        id,
        status: 'skip',
        code: 'CHECK_NOT_RUN',
        detail: 'not run because an earlier check failed',
      },
  );
  return buildReport(checks);
}

/** `ok` only when no check failed; a window end is surfaced only from a passing window check. */
export function buildReport(checks: readonly PreflightCheckResult[]): PreflightReport {
  const window = checks.find((c) => c.id === 'assertWindowOpen' && c.status === 'pass');
  return {
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
    windowEndsAt: window?.windowEndsAt ?? null,
  };
}

/**
 * Maps a report to the state-machine event. An expired SA ends the run `expired` (§8.1); every other
 * hard fail is `failed`, and `status_reason` names the first failing check in canonical order.
 */
export function decide(report: PreflightReport): PreflightDecision {
  if (report.ok) return { event: 'preflight_passed', statusReason: null, report };
  const failures = report.checks.filter((c) => c.status === 'fail');
  const first = failures[0];
  const reason = first
    ? `preflight_failed:${first.id}:${first.code ?? 'CHECK_UNAVAILABLE'}`
    : 'preflight_failed:unknown:CHECK_UNAVAILABLE';
  const expired = failures.some((c) => c.code === 'SA_EXPIRED');
  return { event: expired ? 'sa_expired' : 'fail', statusReason: reason, report };
}
