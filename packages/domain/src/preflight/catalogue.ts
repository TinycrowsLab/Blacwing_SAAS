/**
 * Preflight check catalogue (#579, CONTEXT_PACK §3.2 step 3).
 *
 * The single source of truth for which preflight checks exist, how each one is classed, and what the
 * operator is told to do when it fails. The ids are the ones ORCH-003 already registers its run-time
 * implementations against (`apps/worker/src/run/preflight/types.ts`); a worker test pins the two lists
 * together, so they cannot drift. The workflow bundle cannot import this module (the root index pulls in
 * Node built-ins through contracts), which is why the parity is tested rather than shared by import.
 *
 * `dryRun` marks the checks that are read-only: no login, no SOC notice, no target traffic. A pre-submit
 * dry run runs only those (see `runner.ts`), so a registry that includes a side-effecting check still
 * cannot run it from a dry run.
 */

export const PREFLIGHT_CHECK_IDS = [
  'verifyAuthorisation',
  'resolveAndScopeTargets',
  'verifyAssetsVerified',
  'loginPerRole',
  'assertLockoutExemption',
  'assertWindowOpen',
  'deliverSocNotice',
  'assertBudgetsAvailable',
  'assertModelProviderReachable',
] as const;
export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

/** `blocking` checks decide `ok`; a `warning` check is reported but never stops a run. */
export const PREFLIGHT_SEVERITIES = ['blocking', 'warning'] as const;
export type PreflightSeverity = (typeof PREFLIGHT_SEVERITIES)[number];

export interface PreflightCheckDefinition {
  readonly id: PreflightCheckId;
  readonly title: string;
  readonly severity: PreflightSeverity;
  /** True only for read-only checks that send no target traffic and have no side effects. */
  readonly dryRun: boolean;
  /** Operator-facing next step when the check fails. Never contains a secret. */
  readonly remediation: string;
}

/** Every check, in canonical order (the order ORCH-003 reports them in). */
export const PREFLIGHT_CATALOGUE: readonly PreflightCheckDefinition[] = Object.freeze<
  PreflightCheckDefinition[]
>([
  {
    id: 'verifyAuthorisation',
    title: 'Standing authorisation is active and unexpired',
    severity: 'blocking',
    dryRun: true,
    remediation: 'Renew or re-activate the standing authorisation covering this run.',
  },
  {
    id: 'resolveAndScopeTargets',
    title: 'Targets resolve and are in scope',
    severity: 'blocking',
    dryRun: true,
    remediation:
      'Add the target to the scope rules or fix its DNS record. Private and metadata addresses stay blocked unless explicitly in scope.',
  },
  {
    id: 'verifyAssetsVerified',
    title: 'Assets are verified by their owner (§8.10)',
    severity: 'blocking',
    dryRun: true,
    remediation:
      'Complete ownership verification (DNS TXT, HTTP file or manual letter) for each asset.',
  },
  {
    id: 'loginPerRole',
    title: 'Credentials log in for each role',
    severity: 'blocking',
    dryRun: false,
    remediation:
      'Check the credential reference and login recipe for each role in the session manager.',
  },
  {
    id: 'assertLockoutExemption',
    title: 'Lockout exemption is attested',
    severity: 'blocking',
    dryRun: true,
    remediation: 'Have the customer attest the lockout exemption for the test accounts.',
  },
  {
    id: 'assertWindowOpen',
    title: 'Test window is open',
    severity: 'blocking',
    dryRun: true,
    remediation: 'Schedule the run inside an open test window of the standing authorisation.',
  },
  {
    id: 'deliverSocNotice',
    title: 'SOC notice is delivered',
    severity: 'blocking',
    dryRun: false,
    remediation: 'Confirm the SOC contact can receive notices, then start the run again.',
  },
  {
    id: 'assertBudgetsAvailable',
    title: 'Budgets are available',
    severity: 'blocking',
    dryRun: true,
    remediation: 'Raise the tenant cost cap or lower the request budget for this run.',
  },
  {
    id: 'assertModelProviderReachable',
    title: 'Model provider is reachable',
    severity: 'blocking',
    dryRun: true,
    remediation: 'Check the model gateway credentials and the provider status page.',
  },
]);

/** Type guard for an untrusted string: is it a known check id? */
export function isPreflightCheckId(value: unknown): value is PreflightCheckId {
  return typeof value === 'string' && (PREFLIGHT_CHECK_IDS as readonly string[]).includes(value);
}

/** The definitions for the read-only subset, in canonical order. */
export function dryRunDefinitions(
  definitions: readonly PreflightCheckDefinition[] = PREFLIGHT_CATALOGUE,
): readonly PreflightCheckDefinition[] {
  return definitions.filter((definition) => definition.dryRun);
}
