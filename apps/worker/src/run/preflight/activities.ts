import { SpanStatusCode, trace } from '@opentelemetry/api';

import { isDisallowedAddress } from './address-guard.js';
import {
  PREFLIGHT_CHECK_IDS,
  type FinishPreflightInput,
  type PreflightActivities,
  type PreflightCheckId,
  type PreflightCheckResult,
  type PreflightFailCode,
  type PreflightRef,
} from './types.js';

import type {
  EgressScopeClient,
  ModelProviderProbe,
  PreflightAuditSink,
  PreflightMetrics,
  PreflightRunFacts,
  PreflightRunRepo,
  SessionLoginClient,
  SocNoticeClient,
} from './ports.js';
import type { Logger } from '@blackwing/logger';

export interface PreflightActivityDeps {
  readonly repo: PreflightRunRepo;
  readonly egress: EgressScopeClient;
  readonly sessions: SessionLoginClient;
  readonly notices: SocNoticeClient;
  readonly modelProvider: ModelProviderProbe;
  readonly audit: PreflightAuditSink;
  readonly metrics: PreflightMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
}

const tracer = trace.getTracer('@blackwing/worker');
const ROLE_NAME_MAX = 64;
const MS_PER_SECOND = 1000;

const pass = (id: PreflightCheckId, detail: string): PreflightCheckResult => ({
  id,
  status: 'pass',
  detail,
});
const fail = (
  id: PreflightCheckId,
  code: PreflightFailCode,
  detail: string,
): PreflightCheckResult => ({ id, status: 'fail', code, detail });

/** Role and target names come from the tenant: strip control characters and bound the length. */
function label(value: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the purpose
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, ROLE_NAME_MAX);
}

/** Wraps one check in a span and a log line; a thrown error is recorded and rethrown for the retry. */
async function observed(
  deps: PreflightActivityDeps,
  id: PreflightCheckId,
  ref: PreflightRef,
  body: () => Promise<PreflightCheckResult>,
): Promise<PreflightCheckResult> {
  return tracer.startActiveSpan(`preflight.${id}`, async (span) => {
    try {
      const result = await body();
      span.setAttribute('preflight.status', result.status);
      deps.log.info({ runId: ref.runId, checkId: id, status: result.status }, 'preflight check');
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      deps.log.warn(
        { runId: ref.runId, checkId: id, status: 'error', err },
        'preflight check error',
      );
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Builds the preflight activities over their ports (ORCH-003). Each check is its own activity so a
 * failure is attributable and a transient error is retried per check. Definitive answers (including
 * every hard fail) are returned as values and are therefore never retried; only a port that cannot
 * answer throws. No result ever contains a credential: roles and targets are named, secrets are
 * passed to the session manager by reference only (§8.7).
 */
export function createPreflightActivities(deps: PreflightActivityDeps): PreflightActivities {
  const now = deps.now ?? ((): Date => new Date());

  /** Loads the run facts, or the definitive failure when the run is missing or not in `preflight`. */
  async function load(
    id: PreflightCheckId,
    ref: PreflightRef,
  ): Promise<PreflightRunFacts | PreflightCheckResult> {
    const facts = await deps.repo.load(ref.tenantId, ref.runId);
    if (facts === null) return fail(id, 'RUN_NOT_FOUND', 'run not found for tenant');
    if (facts.state !== 'preflight') {
      return fail(id, 'RUN_NOT_IN_PREFLIGHT', `run is in state ${facts.state}, not preflight`);
    }
    return facts;
  }

  /** Each activity is `observed(load(...) -> body)`. */
  function check(
    id: PreflightCheckId,
    body: (facts: PreflightRunFacts, ref: PreflightRef) => Promise<PreflightCheckResult>,
  ): (ref: PreflightRef) => Promise<PreflightCheckResult> {
    return (ref) =>
      observed(deps, id, ref, async () => {
        const loaded = await load(id, ref);
        return 'status' in loaded ? loaded : body(loaded, ref);
      });
  }

  const verifyAuthorisation = check('verifyAuthorisation', (facts) => {
    const id = 'verifyAuthorisation';
    const { status, expiresAt, validFrom } = facts.authorisation;
    const at = now().getTime();
    // Status and clock are both consulted: a lapsed SA whose status job has not run yet is still expired.
    if (status === 'revoked')
      return Promise.resolve(fail(id, 'SA_REVOKED', 'standing authorisation is revoked'));
    if (status === 'expired' || Date.parse(expiresAt) <= at) {
      return Promise.resolve(fail(id, 'SA_EXPIRED', 'standing authorisation has expired'));
    }
    if (status !== 'active' || Date.parse(validFrom) > at || Number.isNaN(Date.parse(expiresAt))) {
      return Promise.resolve(fail(id, 'SA_NOT_ACTIVE', 'standing authorisation is not active'));
    }
    return Promise.resolve(pass(id, 'standing authorisation is active'));
  });

  const verifyAssetsVerified = check('verifyAssetsVerified', (facts) => {
    const id = 'verifyAssetsVerified';
    if (facts.assets.length === 0) {
      return Promise.resolve(fail(id, 'ASSET_NOT_VERIFIED', 'run has no verified assets'));
    }
    const bad = facts.assets.filter((a) => a.verification !== 'verified');
    if (bad.length > 0) {
      return Promise.resolve(
        fail(id, 'ASSET_NOT_VERIFIED', `${String(bad.length)} asset(s) not verified (§8.10)`),
      );
    }
    return Promise.resolve(pass(id, `${String(facts.assets.length)} asset(s) verified`));
  });

  const assertLockoutExemption = check('assertLockoutExemption', (facts) => {
    const id = 'assertLockoutExemption';
    if (facts.roles.length === 0) return Promise.resolve(pass(id, 'no authenticated roles'));
    if (!facts.authorisation.lockoutExemptionAttested) {
      return Promise.resolve(
        fail(
          id,
          'LOCKOUT_EXEMPTION_MISSING',
          'lockout exemption is not attested for the test accounts',
        ),
      );
    }
    return Promise.resolve(pass(id, 'lockout exemption attested'));
  });

  const assertWindowOpen = check('assertWindowOpen', (facts) => {
    const id = 'assertWindowOpen';
    const at = now().getTime();
    const window = facts.window;
    if (
      window === null ||
      !(Date.parse(window.opensAt) <= at) ||
      !(at < Date.parse(window.closesAt))
    ) {
      return Promise.resolve(fail(id, 'WINDOW_CLOSED', 'no test window is open'));
    }
    return Promise.resolve({
      ...pass(id, `window open until ${window.closesAt}`),
      windowEndsAt: window.closesAt,
    });
  });

  const assertBudgetsAvailable = check('assertBudgetsAvailable', (facts) => {
    const id = 'assertBudgetsAvailable';
    const exhausted = Object.entries(facts.budgetsRemaining)
      .filter(([, value]) => !Number.isFinite(value) || value <= 0)
      .map(([name]) => name);
    if (exhausted.length > 0) {
      return Promise.resolve(
        fail(id, 'BUDGET_EXHAUSTED', `budget exhausted: ${exhausted.join(', ')}`),
      );
    }
    return Promise.resolve(pass(id, 'budgets available'));
  });

  const resolveAndScopeTargets = check('resolveAndScopeTargets', async (facts, ref) => {
    const id = 'resolveAndScopeTargets';
    if (facts.mode !== 'black' && facts.manifestSuppliesSurface) {
      return { id, status: 'skip', detail: 'input manifest supplies the surface' } as const;
    }
    const targets = facts.assets.map((a) => a.target);
    const answers = await deps.egress.resolve({ ...ref, targets });
    const byTarget = new Map(answers.map((a) => [a.target, a]));
    for (const target of targets) {
      const answer = byTarget.get(target);
      // A target the scope engine did not answer for is out of scope: fail closed.
      if (answer?.inScope !== true) {
        return fail(id, 'TARGET_OUT_OF_SCOPE', `target ${label(target)} is out of scope`);
      }
      if (!answer.resolved || answer.addresses.length === 0) {
        return fail(id, 'TARGET_UNRESOLVABLE', `target ${label(target)} did not resolve`);
      }
      if (
        !answer.privateAllowed &&
        answer.addresses.some((address) => isDisallowedAddress(address))
      ) {
        return fail(
          id,
          'TARGET_PRIVATE_ADDRESS',
          `target ${label(target)} resolves to a private or metadata address`,
        );
      }
    }
    return pass(id, `${String(targets.length)} target(s) resolved and in scope`);
  });

  const loginPerRole = check('loginPerRole', async (facts, ref) => {
    const id = 'loginPerRole';
    if (facts.roles.length === 0) return pass(id, 'no authenticated roles');
    const outcomes = await Promise.all(
      facts.roles.map(async (r) => ({
        role: r.role,
        result: await deps.sessions.verifyLogin({
          ...ref,
          role: r.role,
          credentialRef: r.credentialRef,
        }),
      })),
    );
    const failed = outcomes.filter((o) => !o.result.ok).map((o) => label(o.role));
    // No partial authentication: one failed role fails the check, and it is named.
    if (failed.length > 0) {
      return fail(id, 'ROLE_LOGIN_FAILED', `login failed for role(s): ${failed.join(', ')}`);
    }
    return pass(id, `${String(facts.roles.length)} role(s) logged in`);
  });

  const deliverSocNotice = (ref: PreflightRef): Promise<PreflightCheckResult> =>
    observed(deps, 'deliverSocNotice', ref, async () => {
      const id = 'deliverSocNotice';
      const facts = await load(id, ref);
      if ('status' in facts) return facts;
      const state = await deps.notices.ensureDelivered(ref);
      if (state === 'delivered') return pass(id, 'SOC notice delivered');
      if (state === 'failed') return fail(id, 'SOC_NOTICE_FAILED', 'SOC notice delivery failed');
      // Enqueued is not delivered: the customer must be notified before testing. Retried, then failed.
      throw new Error('SOC notice not yet confirmed delivered');
    });

  const assertModelProviderReachable = (ref: PreflightRef): Promise<PreflightCheckResult> =>
    observed(deps, 'assertModelProviderReachable', ref, async () => {
      await deps.modelProvider.ping();
      return pass('assertModelProviderReachable', 'model provider reachable');
    });

  return {
    verifyAuthorisation,
    resolveAndScopeTargets,
    verifyAssetsVerified,
    loginPerRole,
    assertLockoutExemption,
    assertWindowOpen,
    deliverSocNotice,
    assertBudgetsAvailable,
    assertModelProviderReachable,

    async startPreflight(ref) {
      await deps.audit.append({
        action: 'preflight.started',
        outcome: 'success',
        ...ref,
        occurredAt: now().toISOString(),
        dedupeKey: `${ref.runId}:preflight.started`,
        metadata: { checks: PREFLIGHT_CHECK_IDS.length },
      });
      return now().getTime();
    },

    async finishPreflight(input: FinishPreflightInput) {
      const { tenantId, runId, report } = input;
      // Persist first: the report is the record; audit and metrics describe it.
      await deps.repo.saveReport(tenantId, runId, report);
      for (const c of report.checks) {
        await deps.audit.append({
          action: 'preflight.check',
          outcome: c.status === 'fail' ? 'failure' : 'success',
          tenantId,
          runId,
          occurredAt: now().toISOString(),
          dedupeKey: `${runId}:preflight.check:${c.id}`,
          metadata: { checkId: c.id, status: c.status, code: c.code ?? null, detail: c.detail },
        });
        deps.metrics.checkResult(c.id, c.status);
      }
      const firstFailure = report.checks.find((c) => c.status === 'fail');
      await deps.audit.append({
        action: report.ok ? 'preflight.passed' : 'preflight.failed',
        outcome: report.ok ? 'success' : 'failure',
        tenantId,
        runId,
        occurredAt: now().toISOString(),
        dedupeKey: `${runId}:${report.ok ? 'preflight.passed' : 'preflight.failed'}`,
        metadata: { failedCheck: firstFailure?.id ?? null, code: firstFailure?.code ?? null },
      });
      deps.metrics.duration(Math.max(0, now().getTime() - input.startedAtMs) / MS_PER_SECOND);
      deps.log.info({ runId, ok: report.ok }, 'preflight finished');
    },
  };
}
