// Preflight runner (#579): aggregation (every result, ok semantics), failure isolation (throws, timeouts,
// mismatched ids), bounded concurrency, registry validation and the read-only dry-run guarantee.

import { describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import {
  type PreflightCheckDefinition,
  type PreflightCheckId,
  PREFLIGHT_CATALOGUE,
  PREFLIGHT_CHECK_IDS,
} from './catalogue.js';
import {
  PREFLIGHT_RUNNER_CODES,
  type PreflightCheck,
  PreflightConfigError,
  type PreflightResult,
  runDryRunPreflight,
  runPreflight,
} from './runner.js';

interface Ctx {
  readonly calls: PreflightCheckId[];
}

const newCtx = (): Ctx => ({ calls: [] });

function passing(id: PreflightCheckId, detail = `${id} ok`): PreflightResult {
  return { id, status: 'pass', detail };
}

function failing(id: PreflightCheckId, code = 'TEST_FAILURE'): PreflightResult {
  return { id, status: 'fail', code, detail: `${id} failed` };
}

/** A check that records its call on the context and answers with `answer`. */
function check(
  id: PreflightCheckId,
  answer: (id: PreflightCheckId) => PreflightResult,
): PreflightCheck<Ctx> {
  return {
    id,
    run: (ctx) => {
      ctx.calls.push(id);
      return Promise.resolve(answer(id));
    },
  };
}

/** One check per catalogue id, all passing. */
function allPassing(): PreflightCheck<Ctx>[] {
  return PREFLIGHT_CHECK_IDS.map((id) => check(id, passing));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('runPreflight aggregation', () => {
  it('reports ok with every result when all checks pass', async () => {
    const report = await runPreflight(allPassing(), newCtx());
    expect(report.ok).toBe(true);
    expect(report.blockingFailures).toEqual([]);
    expect(report.results.map((result) => result.id)).toEqual([...PREFLIGHT_CHECK_IDS].sort());
    expect(report.results.every((result) => result.status === 'pass')).toBe(true);
  });

  it('collects every result, not only the first failure', async () => {
    const checks = PREFLIGHT_CHECK_IDS.map((id) =>
      check(id, (checkId) =>
        checkId === 'verifyAssetsVerified' || checkId === 'assertWindowOpen'
          ? failing(checkId)
          : passing(checkId),
      ),
    );
    const report = await runPreflight(checks, newCtx());
    expect(report.results).toHaveLength(PREFLIGHT_CHECK_IDS.length);
    expect(report.ok).toBe(false);
    expect(report.blockingFailures).toEqual(['assertWindowOpen', 'verifyAssetsVerified']);
  });

  it('orders results by check id regardless of completion order', async () => {
    // The earliest-listed checks finish last, so completion order is the reverse of id order.
    const checks = PREFLIGHT_CHECK_IDS.map((id, index) => ({
      id,
      run: async () => {
        await sleep((PREFLIGHT_CHECK_IDS.length - index) * 2);
        return passing(id);
      },
    }));
    const report = await runPreflight(checks, newCtx(), {
      concurrency: PREFLIGHT_CHECK_IDS.length,
    });
    expect(report.results.map((result) => result.id)).toEqual([...PREFLIGHT_CHECK_IDS].sort());
  });

  it('keeps a skip without failing the report', async () => {
    const checks = allPassing().map((c) =>
      c.id === 'assertBudgetsAvailable'
        ? check(c.id, (id) => ({ id, status: 'skip', detail: 'not applicable' }))
        : c,
    );
    const report = await runPreflight(checks, newCtx());
    expect(report.ok).toBe(true);
    expect(report.results.find((result) => result.id === 'assertBudgetsAvailable')?.status).toBe(
      'skip',
    );
  });

  it('keeps a failing warning check out of ok and blockingFailures', async () => {
    const definitions: PreflightCheckDefinition[] = [
      {
        id: 'assertBudgetsAvailable',
        title: 'Budgets are available',
        severity: 'warning',
        dryRun: true,
        remediation: 'Raise the cap.',
      },
    ];
    const report = await runPreflight(
      [check('assertBudgetsAvailable', (id) => failing(id))],
      newCtx(),
      { definitions },
    );
    expect(report.ok).toBe(true);
    expect(report.blockingFailures).toEqual([]);
    expect(report.results[0]?.status).toBe('fail');
  });

  it('passes evidence through unchanged', async () => {
    const checks = [
      {
        id: 'assertWindowOpen' as const,
        run: () =>
          Promise.resolve({
            id: 'assertWindowOpen' as const,
            status: 'pass' as const,
            detail: 'window open',
            evidence: {
              closesAt: '2026-11-01T00:00:00.000Z',
              hours: 4,
              inside: true,
              reason: null,
            },
          }),
      },
    ];
    const report = await runPreflight(checks, newCtx(), {
      definitions: PREFLIGHT_CATALOGUE.filter((definition) => definition.id === 'assertWindowOpen'),
    });
    expect(report.results[0]?.evidence).toEqual({
      closesAt: '2026-11-01T00:00:00.000Z',
      hours: 4,
      inside: true,
      reason: null,
    });
  });
});

describe('runPreflight failure isolation', () => {
  it('maps a throwing check to a fail with a stable code and never echoes its message', async () => {
    const checks = allPassing().map((c) =>
      c.id === 'resolveAndScopeTargets'
        ? {
            id: c.id,
            run: (): Promise<PreflightResult> =>
              Promise.reject(new Error('lookup failed for internal-host.corp token=sk-secret-123')),
          }
        : c,
    );
    const report = await runPreflight(checks, newCtx());
    const failed = report.results.find((result) => result.id === 'resolveAndScopeTargets');
    expect(failed?.status).toBe('fail');
    expect(failed?.code).toBe(PREFLIGHT_RUNNER_CODES.CHECK_THREW);
    expect(failed?.detail).not.toContain('secret');
    expect(failed?.detail).not.toContain('internal-host');
    expect(report.blockingFailures).toEqual(['resolveAndScopeTargets']);
    expect(report.results).toHaveLength(PREFLIGHT_CHECK_IDS.length);
  });

  it('maps a synchronous throw the same way as a rejection', async () => {
    const checks = [
      {
        id: 'verifyAuthorisation' as const,
        run: (): Promise<PreflightResult> => {
          throw new TypeError('boom');
        },
      },
    ];
    const report = await runPreflight(checks, newCtx(), {
      definitions: PREFLIGHT_CATALOGUE.filter(
        (definition) => definition.id === 'verifyAuthorisation',
      ),
    });
    expect(report.results[0]).toMatchObject({
      id: 'verifyAuthorisation',
      status: 'fail',
      code: PREFLIGHT_RUNNER_CODES.CHECK_THREW,
    });
  });

  it('fails a check that never settles after the timeout, without hanging the report', async () => {
    const checks = [
      {
        id: 'assertModelProviderReachable' as const,
        run: (): Promise<PreflightResult> => new Promise<PreflightResult>(() => undefined),
      },
    ];
    const report = await runPreflight(checks, newCtx(), {
      definitions: PREFLIGHT_CATALOGUE.filter(
        (definition) => definition.id === 'assertModelProviderReachable',
      ),
      timeoutMs: 10,
    });
    expect(report.ok).toBe(false);
    expect(report.results[0]).toMatchObject({
      id: 'assertModelProviderReachable',
      status: 'fail',
      code: PREFLIGHT_RUNNER_CODES.CHECK_TIMED_OUT,
    });
  });

  it('does not let a late rejection after a timeout escape as an unhandled error', async () => {
    const checks = [
      {
        id: 'assertModelProviderReachable' as const,
        run: async (): Promise<PreflightResult> => {
          await sleep(30);
          throw new Error('late failure');
        },
      },
    ];
    const report = await runPreflight(checks, newCtx(), {
      definitions: PREFLIGHT_CATALOGUE.filter(
        (definition) => definition.id === 'assertModelProviderReachable',
      ),
      timeoutMs: 5,
    });
    expect(report.results[0]?.code).toBe(PREFLIGHT_RUNNER_CODES.CHECK_TIMED_OUT);
    await sleep(40);
  });

  it('fails a check whose result names a different check', async () => {
    const checks = [
      {
        id: 'verifyAuthorisation' as const,
        run: (): Promise<PreflightResult> => Promise.resolve(passing('assertWindowOpen')),
      },
    ];
    const report = await runPreflight(checks, newCtx(), {
      definitions: PREFLIGHT_CATALOGUE.filter(
        (definition) => definition.id === 'verifyAuthorisation',
      ),
    });
    expect(report.results[0]).toMatchObject({
      id: 'verifyAuthorisation',
      status: 'fail',
      code: PREFLIGHT_RUNNER_CODES.RESULT_MISMATCH,
    });
  });
});

describe('runPreflight concurrency', () => {
  it('runs independent checks in parallel but never beyond the configured pool size', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const checks = PREFLIGHT_CHECK_IDS.map((id) => ({
      id,
      run: async (): Promise<PreflightResult> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight -= 1;
        return passing(id);
      },
    }));
    await runPreflight(checks, newCtx(), { concurrency: 2 });
    expect(maxInFlight).toBe(2);
  });

  it('rejects a pool size that is not a positive integer', async () => {
    await expect(runPreflight(allPassing(), newCtx(), { concurrency: 0 })).rejects.toBeInstanceOf(
      PreflightConfigError,
    );
    await expect(runPreflight(allPassing(), newCtx(), { concurrency: 1.5 })).rejects.toBeInstanceOf(
      PreflightConfigError,
    );
  });

  it('rejects a timeout that is not a positive integer', async () => {
    await expect(runPreflight(allPassing(), newCtx(), { timeoutMs: -1 })).rejects.toBeInstanceOf(
      PreflightConfigError,
    );
  });
});

describe('runPreflight registry validation', () => {
  it('rejects a check id that is not in the catalogue', async () => {
    const definitions = PREFLIGHT_CATALOGUE.filter(
      (definition) => definition.id === 'verifyAuthorisation',
    );
    const error = await runPreflight([check('loginPerRole', passing)], newCtx(), {
      definitions,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreflightConfigError);
    expect(isAppError(error) && error.code).toBe('INTERNAL');
    expect((error as Error).message).toContain('loginPerRole');
  });

  it('rejects a check that is registered twice', async () => {
    await expect(
      runPreflight([...allPassing(), check('verifyAuthorisation', passing)], newCtx()),
    ).rejects.toBeInstanceOf(PreflightConfigError);
  });

  it('rejects a catalogue check that is not registered, so ok cannot pass silently', async () => {
    const checks = allPassing().filter((c) => c.id !== 'assertWindowOpen');
    const error = await runPreflight(checks, newCtx()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreflightConfigError);
    expect((error as Error).message).toContain('assertWindowOpen');
  });
});

describe('runDryRunPreflight read-only guarantee', () => {
  const readOnlyIds = PREFLIGHT_CATALOGUE.filter((definition) => definition.dryRun).map(
    (definition) => definition.id,
  );

  it('runs only read-only checks, so no login and no SOC notice fire even when registered', async () => {
    const ctx = newCtx();
    const report = await runDryRunPreflight(allPassing(), ctx);
    expect(ctx.calls).not.toContain('loginPerRole');
    expect(ctx.calls).not.toContain('deliverSocNotice');
    expect(ctx.calls.sort()).toEqual([...readOnlyIds].sort());
    expect(report.results.map((result) => result.id)).toEqual([...readOnlyIds].sort());
  });

  it('reports ok when every read-only check passes, without requiring the side-effecting ones', async () => {
    const ctx = newCtx();
    const registry = allPassing().filter(
      (c) => c.id !== 'loginPerRole' && c.id !== 'deliverSocNotice',
    );
    const report = await runDryRunPreflight(registry, ctx);
    expect(report.ok).toBe(true);
  });

  it('reports a failing read-only blocking check as a blocking failure', async () => {
    const checks = allPassing().map((c) =>
      c.id === 'assertWindowOpen' ? check(c.id, failing) : c,
    );
    const report = await runDryRunPreflight(checks, newCtx());
    expect(report.ok).toBe(false);
    expect(report.blockingFailures).toEqual(['assertWindowOpen']);
  });

  it('rejects a registry that is missing a read-only check', async () => {
    const checks = allPassing().filter((c) => c.id !== 'assertBudgetsAvailable');
    await expect(runDryRunPreflight(checks, newCtx())).rejects.toBeInstanceOf(PreflightConfigError);
  });

  it('rejects a registry that names an id outside the catalogue', async () => {
    const ctx = newCtx();
    await expect(
      runDryRunPreflight([...allPassing(), check('bogus' as PreflightCheckId, passing)], ctx),
    ).rejects.toBeInstanceOf(PreflightConfigError);
    expect(ctx.calls).toEqual([]);
  });
});
