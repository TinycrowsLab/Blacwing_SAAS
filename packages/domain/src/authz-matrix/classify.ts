import { z } from 'zod';

import { LIMITS, type RoleSessionStatus } from '@blackwing/contracts';

import type { ExpectedAccess } from './model.js';

/**
 * Deterministic access-outcome classifier and the access-matrix oracle verdict (AUTHLOGIC-002, #695, F14, F16).
 *
 * Both are pure functions of recorded data, so the Validator can replay them. The classifier never reads the
 * response for intent: it looks only at the status, a redirect target and the leading body window. Anything it
 * cannot place with confidence is `ambiguous`, which the verdict turns into Suspected, never into a finding.
 */

export const ACCESS_OUTCOMES = ['allow', 'deny', 'ambiguous'] as const;
export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** A captured response, as the gateway records it. Only the fields the classifier reads. */
export const recordedResponseSchema = z.strictObject({
  status: z.int().min(HTTP_STATUS_MIN).max(HTTP_STATUS_MAX),
  location: z.string().max(LIMITS.urlMax).optional(),
  body: z.string().optional(),
});
export type RecordedResponse = z.infer<typeof recordedResponseSchema>;

/** Only this many leading body characters are inspected for soft-deny text, so classification stays bounded. */
export const ACCESS_BODY_WINDOW = 4_096;

/** The redirect statuses a login bounce can use (301, 302, 303, 307, 308). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set(
  Object.values({
    movedPermanently: 301,
    found: 302,
    seeOther: 303,
    temporaryRedirect: 307,
    permanentRedirect: 308,
  }),
);
/** A redirect to a login page, on the relative or absolute target's path (`/login`, `/signin`, `/auth`, `/sso` …). */
const LOGIN_PATH = /^\/(?:login|log-in|signin|sign-in|auth|sso)(?:[/?#]|$)/i;
/** Soft-deny wording in a 2xx body: the server refused, but answered 200. Such a response is ambiguous. */
const SOFT_DENY =
  /access denied|not authori[sz]ed|forbidden|permission denied|login required|please (?:log ?in|sign ?in)/i;

function redirectsToLogin(location: string | undefined): boolean {
  if (location === undefined) return false;
  try {
    return LOGIN_PATH.test(new URL(location, 'https://target.invalid').pathname);
  } catch {
    return false;
  }
}

/**
 * Maps a recorded response to `allow`, `deny` or `ambiguous`:
 * - 401 and 403 are `deny`, and so is a redirect to a login page;
 * - a 2xx with a non-blank body that carries no soft-deny text is `allow`;
 * - everything else is `ambiguous`: a 2xx with an empty body or soft-deny text (200 used as a refusal), a 404
 *   (not proof of access control), a 5xx, or any other redirect.
 * A response that does not match the recorded-response schema is `ambiguous` too, so bad input never allows.
 */
export function classifyAccessResponse(input: unknown): AccessOutcome {
  const parsed = recordedResponseSchema.safeParse(input);
  if (!parsed.success) return 'ambiguous';
  const { status, location, body = '' } = parsed.data;
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return 'deny';
  if (REDIRECT_STATUSES.has(status)) return redirectsToLogin(location) ? 'deny' : 'ambiguous';
  if (status < HTTP_OK_MIN || status > HTTP_OK_MAX) return 'ambiguous';
  const window = body.slice(0, ACCESS_BODY_WINDOW);
  if (window.trim() === '') return 'ambiguous';
  if (SOFT_DENY.test(window)) return 'ambiguous';
  return 'allow';
}

/**
 * The verdict of one matrix cell:
 * - `pass`: the observed access equals the declared expectation;
 * - `violation`: the matrix says deny, the acting role was allowed, and the negative control was allowed too,
 *   so the differential across roles is real (a confirmable access-control flaw, pending the Validator);
 * - `mismatch`: the matrix says allow but the acting role was denied (a functional gap, not a security finding);
 * - `suspected`: the outcome is ambiguous, or a violation has no valid negative control;
 * - `unknown`: the matrix does not declare the cell, so nothing is asserted;
 * - `blocked`: the acting role has no live session, so no comparison was made.
 */
export const ACCESS_MATRIX_VERDICTS = [
  'pass',
  'violation',
  'mismatch',
  'suspected',
  'unknown',
  'blocked',
] as const;
export type AccessMatrixVerdict = (typeof ACCESS_MATRIX_VERDICTS)[number];

/** Stable reason codes, so a verdict can be logged and compared without free text. */
export const ACCESS_MATRIX_REASONS = {
  sessionNotLive: 'session_not_live',
  cellNotDeclared: 'cell_not_declared',
  ambiguousResponse: 'ambiguous_response',
  matchesExpected: 'matches_expected',
  allowedWhereDenied: 'allowed_where_denied',
  deniedWhereAllowed: 'denied_where_allowed',
  controlMissingOrFailed: 'negative_control_missing_or_failed',
} as const;

export interface AccessMatrixEvaluationInput {
  /** The declared expectation from the matrix, or `unknown` when the cell is not declared. */
  readonly expected: ExpectedAccess | 'unknown';
  /** The acting role's session status. Anything other than `live` blocks the comparison. */
  readonly sessionStatus: RoleSessionStatus;
  /** The classified outcome of the acting role's request. */
  readonly actual: AccessOutcome;
  /** The classified outcome of the negative control (a correctly authorised request). Undefined when none ran. */
  readonly control?: AccessOutcome | undefined;
}

export interface AccessMatrixEvaluation {
  readonly verdict: AccessMatrixVerdict;
  readonly reason: (typeof ACCESS_MATRIX_REASONS)[keyof typeof ACCESS_MATRIX_REASONS];
}

/**
 * Evaluates one cell. Checks run in order: session, declaration, ambiguity, then the expectation. A deny that
 * the matrix expects but the acting role receives is a violation only when the negative control is allowed, so a
 * single-role 200 or 403 is never a finding on its own; the differential across roles is what counts.
 */
export function evaluateAccessMatrixCell(
  input: AccessMatrixEvaluationInput,
): AccessMatrixEvaluation {
  if (input.sessionStatus !== 'live') {
    return { verdict: 'blocked', reason: ACCESS_MATRIX_REASONS.sessionNotLive };
  }
  if (input.expected === 'unknown') {
    return { verdict: 'unknown', reason: ACCESS_MATRIX_REASONS.cellNotDeclared };
  }
  if (input.actual === 'ambiguous') {
    return { verdict: 'suspected', reason: ACCESS_MATRIX_REASONS.ambiguousResponse };
  }
  if (input.actual === input.expected) {
    return { verdict: 'pass', reason: ACCESS_MATRIX_REASONS.matchesExpected };
  }
  if (input.expected === 'allow') {
    return { verdict: 'mismatch', reason: ACCESS_MATRIX_REASONS.deniedWhereAllowed };
  }
  if (input.control === 'allow') {
    return { verdict: 'violation', reason: ACCESS_MATRIX_REASONS.allowedWhereDenied };
  }
  return { verdict: 'suspected', reason: ACCESS_MATRIX_REASONS.controlMissingOrFailed };
}
