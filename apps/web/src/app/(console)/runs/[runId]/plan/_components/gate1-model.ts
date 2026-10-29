import {
  GATE1_DECISIONS_REQUIRING_REASON,
  GATE1_REASON_MAX,
  type Gate1Decision,
  type Gate1DecisionRequest,
} from '@blackwing/contracts';

import { CLIENT_ERROR_CODES, isApiError } from '../../../../../../lib/api-error';

/** Button and radio labels for each decision (Gate 1, #877). */
export const DECISION_LABEL: Readonly<Record<Gate1Decision, string>> = {
  approve: 'Approve plan',
  request_changes: 'Request changes',
  reject: 'Reject plan',
};

/** What each decision does to the run, shown under its radio button. */
export const DECISION_HINT: Readonly<Record<Gate1Decision, string>> = {
  approve: 'The run moves to approved and can start execution.',
  request_changes: 'The plan goes back to planning. Say what must change.',
  reject: 'The run is cancelled. Say why.',
};

export function decisionNeedsReason(decision: Gate1Decision): boolean {
  return GATE1_DECISIONS_REQUIRING_REASON.includes(decision);
}

/** The message for an invalid reason, or `null` when the decision may be submitted. */
export function reasonError(decision: Gate1Decision, reason: string): string | null {
  const trimmed = reason.trim();
  if (decisionNeedsReason(decision) && trimmed.length === 0) {
    return 'Add a reason for this decision.';
  }
  if (trimmed.length > GATE1_REASON_MAX) {
    return `The reason is longer than ${String(GATE1_REASON_MAX)} characters.`;
  }
  return null;
}

/** The request body for a decision: the reason is sent only when there is one. */
export function decisionBody(
  decision: Gate1Decision,
  planVersion: number,
  reason: string,
): Gate1DecisionRequest {
  const trimmed = reason.trim();
  return trimmed.length === 0
    ? { decision, planVersion }
    : { decision, planVersion, reason: trimmed };
}

/**
 * The idempotency key of one decision attempt. The same body keeps the key, so a double submit or a retry after
 * a lost response repeats the same decision and the server records it once. A changed body gets a new key.
 */
export interface DecisionAttempt {
  readonly key: string;
  readonly body: Gate1DecisionRequest;
}

export function attemptFor(
  previous: DecisionAttempt | null,
  body: Gate1DecisionRequest,
  newKey: () => string,
): DecisionAttempt {
  if (previous !== null && JSON.stringify(previous.body) === JSON.stringify(body)) return previous;
  return { key: newKey(), body };
}

/** The separation-of-duties banner text (#877 requirement 3). */
export function sodBannerText(requesterId: string | null, approverId: string | null): string {
  return `Requester: ${requesterId ?? 'unknown'}, Approver: ${approverId ?? 'unknown'}`;
}

/** Why a decision did not record, in words the approver can act on. */
export interface DecisionFailure {
  /** Stable code the server answered with, or a client code. */
  readonly code: string;
  readonly message: string;
  /** The plan or run changed: reload before deciding again. */
  readonly refresh: boolean;
  /** Retrying the same attempt (same key) is safe. */
  readonly retryable: boolean;
  readonly traceId: string | undefined;
}

const FAILURE_MESSAGE: Readonly<Record<string, string>> = {
  SOD_VIOLATION:
    'Separation of duties: you requested this plan, so you cannot approve it. The server refused the decision.',
  GATE1_NOT_PENDING:
    'This plan is no longer waiting for approval. The latest state is shown below.',
  GATE1_PLAN_STALE:
    'The plan changed after you opened it. Review the new version below, then decide again.',
  GATE1_EXPIRED: 'The approval window for this plan has closed. It can no longer be approved.',
  FORBIDDEN: 'Your role cannot approve test plans.',
  NOT_FOUND: 'This run is not available to you.',
  IDEMPOTENCY_KEY_MISMATCH:
    'This decision conflicts with an earlier attempt. Reload and try again.',
  VALIDATION_FAILED: 'The decision is incomplete. Check the reason and try again.',
  [CLIENT_ERROR_CODES.network]:
    'The server could not be reached. The decision has not been recorded; retry to send it again.',
};

const HTTP_CONFLICT = 409;

const REFRESH_CODES: ReadonlySet<string> = new Set([
  'GATE1_NOT_PENDING',
  'GATE1_PLAN_STALE',
  'GATE1_EXPIRED',
]);

/** Maps any failure of a decision request to the message and follow-up the review shows. */
export function failureOf(error: unknown): DecisionFailure {
  if (isApiError(error)) {
    const known = FAILURE_MESSAGE[error.code];
    return {
      code: error.code,
      message: known ?? error.detail ?? error.title,
      refresh: REFRESH_CODES.has(error.code) || error.status === HTTP_CONFLICT,
      retryable: error.code === CLIENT_ERROR_CODES.network,
      traceId: error.traceId,
    };
  }
  return {
    code: 'UNKNOWN',
    message: 'The decision did not record. Reload the page and check the run before trying again.',
    refresh: true,
    retryable: false,
    traceId: undefined,
  };
}
