import { lookup } from 'node:dns/promises';

import {
  PREFLIGHT_CATALOGUE,
  type PreflightCheck,
  type PreflightCheckDefinition,
  type PreflightCheckId,
  type PreflightResult,
} from '@blackwing/domain';

import type { ModelProviderProbe, StandingAuthorisationFact, TargetResolver } from './ports.js';
import type { SubmitFailure } from './submit-checks.js';

/**
 * The read-only checks of the pre-submit dry run (#579). Each one reads our own records: the submit gate's
 * findings (`checkSubmission`), the standing authorisation's window and the model provider's reachability.
 * No login, no SOC notice and no target traffic: those are run-time checks (ORCH-003).
 */

/** Dry-run check ids: exactly the read-only subset of the domain catalogue (asserted by a test). */
export type DryRunCheckId =
  | 'verifyAuthorisation'
  | 'resolveAndScopeTargets'
  | 'verifyAssetsVerified'
  | 'assertLockoutExemption'
  | 'assertWindowOpen'
  | 'assertBudgetsAvailable'
  | 'assertModelProviderReachable';

/** Upper bound on one model-provider probe in a dry run (§ #579: a dry run uses a short timeout). */
const PREFLIGHT_PROVIDER_TIMEOUT_MS = 2_000;
/** Backstop for any one dry-run check; the provider probe answers well before it. */
export const PREFLIGHT_DRY_RUN_CHECK_TIMEOUT_MS = 5_000;

export const PREFLIGHT_PROVIDER_TIMEOUT_CODE = 'PREFLIGHT_PROVIDER_TIMEOUT';
export const PREFLIGHT_PROVIDER_UNREACHABLE_CODE = 'MODEL_PROVIDER_UNREACHABLE';
export const PREFLIGHT_NOT_RUN_CODE = 'PREFLIGHT_NOT_RUN_IN_DRY_RUN';

/** What every dry-run check reads. Built once per dry run, so each check is a pure function of it. */
export interface DryRunFacts {
  readonly now: Date;
  /** The submit gate's findings for the request, every failing check (SCOPE-005). */
  readonly failures: readonly SubmitFailure[];
  /** The standing authorisation the request names, or undefined when none is visible in the tenant. */
  readonly sa: StandingAuthorisationFact | undefined;
  readonly assetCount: number;
  /** One entry per asset: the hostnames its targets resolve through. */
  readonly assetHosts: readonly (readonly string[])[];
}

export interface DryRunContext {
  readonly facts: DryRunFacts;
  readonly modelProbe: ModelProviderProbe | undefined;
  readonly resolver: TargetResolver;
}

/** The system resolver: one DNS lookup per host, no request to the target. */
export const systemTargetResolver: TargetResolver = {
  async resolve(host) {
    const answers = await lookup(host, { all: true, verbatim: true });
    return answers.map((answer) => answer.address);
  },
};

const PREFLIGHT_DNS_UNRESOLVED_CODE = 'TARGET_UNRESOLVABLE';

/**
 * Resolves each asset host once (the gateway's resolve-once rule, EGRESS-008) and pins the first address of the
 * first host into the evidence. A host that does not resolve, or an asset with no host, fails closed.
 */
async function resolveHosts(
  id: PreflightCheckId,
  assetHosts: readonly (readonly string[])[],
  resolver: TargetResolver,
  passDetail: string,
): Promise<PreflightResult> {
  const hosts = [...new Set(assetHosts.flat())];
  if (assetHosts.some((entry) => entry.length === 0)) {
    return failed(id, PREFLIGHT_DNS_UNRESOLVED_CODE, 'an asset has no hostname to resolve');
  }
  const pinned = new Map<string, string>();
  for (const host of hosts) {
    let addresses: readonly string[];
    try {
      addresses = await resolver.resolve(host);
    } catch {
      return failed(id, PREFLIGHT_DNS_UNRESOLVED_CODE, `host ${host} did not resolve`);
    }
    const first = addresses[0];
    if (first === undefined) {
      return failed(id, PREFLIGHT_DNS_UNRESOLVED_CODE, `host ${host} did not resolve`);
    }
    pinned.set(host, first);
  }
  const [firstHost] = hosts;
  const firstAddress = firstHost === undefined ? undefined : pinned.get(firstHost);
  return {
    id,
    status: 'pass',
    detail: passDetail,
    ...(firstHost === undefined || firstAddress === undefined
      ? {}
      : {
          evidence: {
            pinnedHost: firstHost,
            pinnedAddress: firstAddress,
            hostsResolved: hosts.length,
          },
        }),
  };
}

/** The failures of the submit gate that a named check reports, or a pass when none of them occurred. */
function judged(
  id: PreflightCheckId,
  failures: readonly SubmitFailure[],
  codes: readonly SubmitFailure['code'][],
  passDetail: string,
): PreflightResult {
  const hits = failures.filter((failure) => codes.includes(failure.code));
  const first = hits[0];
  if (first === undefined) return { id, status: 'pass', detail: passDetail };
  return {
    id,
    status: 'fail',
    code: first.code,
    detail: hits.map((hit) => hit.message).join(' '),
  };
}

function failed(id: PreflightCheckId, code: string, detail: string): PreflightResult {
  return { id, status: 'fail', code, detail };
}

/** A probe that does not settle within `timeoutMs` is a timeout, and a probe that throws is "unreachable". */
async function probeProvider(
  probe: ModelProviderProbe,
  timeoutMs: number,
): Promise<PreflightResult> {
  const id = 'assertModelProviderReachable';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const answer = await Promise.race([probe.reachable(), timedOut]);
    if (answer === 'timeout') {
      return failed(
        id,
        PREFLIGHT_PROVIDER_TIMEOUT_CODE,
        `the model provider did not answer within ${String(timeoutMs)} ms`,
      );
    }
    return answer
      ? { id, status: 'pass', detail: 'model provider reachable' }
      : failed(id, PREFLIGHT_PROVIDER_UNREACHABLE_CODE, 'the model provider is not reachable');
  } catch {
    return failed(id, PREFLIGHT_PROVIDER_UNREACHABLE_CODE, 'the model provider probe failed');
  } finally {
    clearTimeout(timer);
  }
}

/** The dry-run checks by id. A test pins the keys to the read-only subset of the catalogue. */
export const DRY_RUN_CHECKS: Readonly<
  Record<DryRunCheckId, (ctx: DryRunContext) => Promise<PreflightResult>>
> = {
  verifyAuthorisation: ({ facts }) =>
    Promise.resolve(
      judged(
        'verifyAuthorisation',
        facts.failures,
        [
          'SA_REQUIRED',
          'SA_EXPIRED',
          'SA_NOT_ACTIVE',
          'INTRUSIVENESS_EXCEEDS_SA',
          'INTRUSIVENESS_NOT_AUTHORISED',
        ],
        'the standing authorisation is active and covers the requested intrusiveness',
      ),
    ),

  resolveAndScopeTargets: async ({ facts, resolver }) => {
    const id = 'resolveAndScopeTargets';
    const scoped = judged(
      id,
      facts.failures,
      ['NO_ASSETS', 'SA_SCOPE_MISMATCH', 'SCOPE_EXCEEDS_SA'],
      `${String(facts.assetCount)} asset(s) and the scope rules are covered by the standing authorisation`,
    );
    if (scoped.status === 'fail') return scoped;
    return resolveHosts(
      id,
      facts.assetHosts,
      resolver,
      'every target host resolves and is in scope',
    );
  },

  verifyAssetsVerified: ({ facts }) =>
    Promise.resolve(
      judged(
        'verifyAssetsVerified',
        facts.failures,
        ['ASSET_NOT_VERIFIED'],
        `${String(facts.assetCount)} asset(s) verified (§8.10)`,
      ),
    ),

  // The exemption is an attestation read per run (ORCH-003). A dry run reads no attestation, so it reports the
  // check as not run rather than inventing a verdict. A skip never blocks `ok`.
  assertLockoutExemption: () =>
    Promise.resolve({
      id: 'assertLockoutExemption',
      status: 'skip',
      detail: 'the lockout exemption is checked per run; a dry run reads no attestation',
      code: PREFLIGHT_NOT_RUN_CODE,
    }),

  assertWindowOpen: ({ facts }) => {
    const id = 'assertWindowOpen';
    const sa = facts.sa;
    if (sa === undefined) {
      return Promise.resolve(
        failed(id, 'WINDOW_CLOSED', 'no standing authorisation, so no test window is open'),
      );
    }
    const at = facts.now.getTime();
    if (at < sa.validFrom.getTime() || at >= sa.expiresAt.getTime()) {
      return Promise.resolve(
        failed(id, 'WINDOW_CLOSED', 'no test window of the standing authorisation is open'),
      );
    }
    return Promise.resolve({
      id,
      status: 'pass',
      detail: 'a test window of the standing authorisation is open',
      evidence: { windowEndsAt: sa.expiresAt.toISOString() },
    });
  },

  assertBudgetsAvailable: ({ facts }) =>
    Promise.resolve(
      judged(
        'assertBudgetsAvailable',
        facts.failures,
        ['BUDGET_EXCEEDS_SA'],
        'the requested budgets are within the standing authorisation',
      ),
    ),

  assertModelProviderReachable: async ({ modelProbe }) => {
    const id = 'assertModelProviderReachable';
    if (modelProbe === undefined) {
      return failed(
        id,
        PREFLIGHT_PROVIDER_UNREACHABLE_CODE,
        'no model provider probe is configured for this deployment',
      );
    }
    return probeProvider(modelProbe, PREFLIGHT_PROVIDER_TIMEOUT_MS);
  },
};

/** The catalogue entry (title, severity, remediation) of each check, by id. */
export const CATALOGUE_BY_ID: ReadonlyMap<string, PreflightCheckDefinition> = new Map(
  PREFLIGHT_CATALOGUE.map((definition) => [definition.id, definition]),
);

/** The dry-run registry: one check per read-only id, each wrapped by `wrap` (metrics, spans). */
export function dryRunRegistry(
  wrap: (id: DryRunCheckId, run: () => Promise<PreflightResult>) => Promise<PreflightResult>,
): PreflightCheck<DryRunContext>[] {
  return (Object.keys(DRY_RUN_CHECKS) as DryRunCheckId[]).map((id) => ({
    id,
    run: (ctx: DryRunContext) => wrap(id, () => DRY_RUN_CHECKS[id](ctx)),
  }));
}
