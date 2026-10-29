import { AppError } from '@blackwing/errors';

/**
 * Step-up authentication for approving a standing authorisation (AUTHZ-008, §8.4). Approval is a high-value
 * decision, so the approver must have authenticated freshly, with a strong second factor, shortly before it.
 * The evidence is the validated token's own claims (`auth_time`, `acr`); this module never parses a token.
 */

/** The realm's strong authentication context (IAM-009, `acr.loa.map` strong = 2). */
export const STEPUP_DEFAULT_ACR = 'strong';
/** How old the last authentication may be, in seconds, when the approval happens (`AUTHZ_STEPUP_MAX_AGE_S`). */
export const STEPUP_DEFAULT_MAX_AGE_S = 300;
/** The largest age the configuration may set (one hour). */
export const STEPUP_MAX_AGE_LIMIT_S = 3600;
/** The longest acr the configuration may name. */
export const STEPUP_ACR_MAX_CHARS = 128;
const MS_PER_S = 1000;

/** `AUTHZ_STEPUP_MAX_AGE_S` and `AUTHZ_STEPUP_ACR`, as the approval flow reads them. */
export interface StepUpPolicy {
  /** The largest age, in seconds, of the approver's last authentication. */
  readonly maxAgeS: number;
  /** The authentication context class the approver's session must assert. */
  readonly acr: string;
}

export const DEFAULT_STEPUP_POLICY: StepUpPolicy = {
  maxAgeS: STEPUP_DEFAULT_MAX_AGE_S,
  acr: STEPUP_DEFAULT_ACR,
};

/** What the validated caller proves about its last authentication. Either part may be absent. */
export interface StepUpEvidence {
  /** The `acr` claim of the session's token. */
  readonly acr?: string | undefined;
  /** The `auth_time` claim: when the user last authenticated, epoch seconds. */
  readonly authTime?: number | undefined;
}

/**
 * Refuses an approval unless the caller authenticated with the required `acr` within `maxAgeS` seconds of `nowMs`.
 * A missing `auth_time`, a missing or different `acr`, and an `auth_time` in the future are all refused: the
 * challenge (`AUTHZ_STEPUP_REQUIRED`, 401) tells the client to re-authenticate and retry.
 */
export function assertStepUp(evidence: StepUpEvidence, policy: StepUpPolicy, nowMs: number): void {
  const nowS = Math.floor(nowMs / MS_PER_S);
  const authTime = evidence.authTime;
  const fresh = authTime !== undefined && authTime <= nowS && nowS - authTime <= policy.maxAgeS;
  const strong = evidence.acr === policy.acr;
  if (!fresh || !strong) {
    throw new StepUpRequiredError(policy);
  }
}

/** `AUTHZ_STEPUP_REQUIRED` (401): approval needs a fresh strong authentication. The detail is the challenge. */
class StepUpRequiredError extends AppError {
  declare readonly code: 'AUTHZ_STEPUP_REQUIRED';

  constructor(policy: StepUpPolicy) {
    super('AUTHZ_STEPUP_REQUIRED', 'Step-up authentication required', {
      detail: `Re-authenticate with acr "${policy.acr}" within the last ${String(policy.maxAgeS)} seconds, then retry.`,
    });
  }
}
