import { z } from 'zod';

/**
 * Assessment request states (SCOPE-001, CONTEXT_PACK §7). A request is the scoping form's output: `draft`
 * is editable, `submitted` waits for the standing authorisation and approval, `promoted` became a run
 * (ORCH owns the `runs` row), and `withdrawn` or `rejected` end it without one.
 */
export const ASSESSMENT_REQUEST_STATUSES = [
  'draft',
  'submitted',
  'withdrawn',
  'promoted',
  'rejected',
] as const;
export const assessmentRequestStatusSchema = z.enum(ASSESSMENT_REQUEST_STATUSES);
export type AssessmentRequestStatus = z.infer<typeof assessmentRequestStatusSchema>;

/** Allowed status changes. A terminal status (`withdrawn`, `promoted`, `rejected`) has no outgoing change. */
export const ASSESSMENT_REQUEST_TRANSITIONS: Readonly<
  Record<AssessmentRequestStatus, readonly AssessmentRequestStatus[]>
> = Object.freeze({
  draft: ['submitted', 'withdrawn'],
  submitted: ['promoted', 'rejected', 'withdrawn'],
  withdrawn: [],
  promoted: [],
  rejected: [],
});

/** True when a request may move from `from` to `to`. Anything not listed in the table is refused. */
export function canTransitionAssessmentRequest(
  from: AssessmentRequestStatus,
  to: AssessmentRequestStatus,
): boolean {
  return ASSESSMENT_REQUEST_TRANSITIONS[from].includes(to);
}
