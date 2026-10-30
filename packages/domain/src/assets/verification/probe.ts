import type { LocationIdentifier } from './location.js';
import type { VerificationMethod } from '@blackwing/contracts';

/**
 * The probe port of the verification framework (ASSET-003). A probe checks one method's location for the token and
 * nothing else. It runs in the control plane or the worker, never on the sandbox egress path, and is pure from the
 * framework's point of view: it reads the network, it writes nothing. ASSET-005 (DNS TXT) and ASSET-006 (HTTP file)
 * each add one implementation; the API only dispatches by `method`.
 */

/** What a probe is asked to check. The token and location come from the challenge, never from the caller. */
export interface VerificationProbeTarget {
  readonly method: VerificationMethod;
  readonly token: string;
  readonly expectedLocation: string | null;
  readonly identifiers: readonly LocationIdentifier[];
}

/**
 * The answer of one probe run. `not_found` carries a short machine reason (for example `token_absent`); it is
 * recorded in metrics and logs, never the token or the observed value.
 */
export type VerificationProbeResult =
  { readonly outcome: 'passed' } | { readonly outcome: 'not_found'; readonly reason: string };

export interface VerificationProbe {
  readonly method: VerificationMethod;
  check(target: VerificationProbeTarget): Promise<VerificationProbeResult>;
}

/**
 * Tunables of the verification lifecycle. Keys are the platform config names (`bw.asset.*`); the defaults are the
 * ones the issue fixes, and the API overrides them through its module options.
 */
export interface VerificationPolicy {
  /** `bw.asset.verificationTtlDays`: how long a verified asset stays verified. */
  readonly verificationTtlDays: number;
  /** `bw.asset.challengeTtlHours`: how long a challenge may stay open. */
  readonly challengeTtlHours: number;
  /** `bw.asset.maxCheckAttempts`: probe runs one challenge may spend before it fails. */
  readonly maxCheckAttempts: number;
  /** `bw.asset.rotateOnRestart`: whether restarting a pending verification issues a new token. */
  readonly rotateOnRestart: boolean;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = Object.freeze({
  verificationTtlDays: 90,
  challengeTtlHours: 72,
  maxCheckAttempts: 20,
  rotateOnRestart: true,
});
