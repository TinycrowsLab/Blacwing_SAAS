import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  canTransitionTestCase,
  DISPATCH_SUBTASK_UPDATE,
  type EngagementDispatchInput,
  type EngagementDispatchResult,
  type EngagementMarkTestCaseInput,
  type EngagementMarkTestCaseResult,
  type EngagementMentorReviewInput,
  type EngagementOpenSubtasks,
  type EngagementScopeExceptionInput,
  type EngagementScopeExceptionResult,
  type EngagementState,
  type EngagementSubtaskResult,
  executionWorkflowId,
  subtaskStatusSchema,
  type TestCaseStatus,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

/**
 * Engagement endpoints of the Run Broker (MCP-012, #677). The orchestrator's tools reach them with a run-scoped
 * token. Each capability is an adapter behind a port; a capability whose adapter is not wired answers
 * `NOT_IMPLEMENTED` (501), the broker's fail-closed convention, so nothing pretends to work.
 */

/** The run a call is bound to. Taken from the token, never from the body (§8.6). */
export interface EngagementRef {
  readonly tenantId: string;
  readonly runId: string;
}

/** Everything the engagement endpoints answer with. */
export interface EngagementPort {
  state(ref: EngagementRef): Promise<EngagementState>;
  openSubtasks(ref: EngagementRef): Promise<EngagementOpenSubtasks>;
  dispatch(ref: EngagementRef, input: EngagementDispatchInput): Promise<EngagementDispatchResult>;
  subtaskResult(ref: EngagementRef, subtaskId: string): Promise<EngagementSubtaskResult | null>;
  markTestCase(
    ref: EngagementRef,
    input: EngagementMarkTestCaseInput,
  ): Promise<EngagementMarkTestCaseResult>;
  requestMentorReview(
    ref: EngagementRef,
    input: EngagementMentorReviewInput,
  ): Promise<{ readonly reviewId: string; readonly status: 'requested' }>;
  requestScopeException(
    ref: EngagementRef,
    input: EngagementScopeExceptionInput,
  ): Promise<EngagementScopeExceptionResult>;
}

/** The test case's persisted status, read and compare-and-set inside the run's tenant context (§8.6). */
export interface TestCaseStatusStore {
  currentStatus(ref: EngagementRef, testCaseId: string): Promise<TestCaseStatus | null>;
  /** Moves `from → to` only while the row is still `from`. False when it was not. */
  compareAndSet(
    ref: EngagementRef,
    testCaseId: string,
    from: TestCaseStatus,
    to: TestCaseStatus,
    reason: string,
  ): Promise<boolean>;
}

/** The Temporal side: an update sent to the run's Run Controller (ExecutionWorkflow). */
export interface RunControllerClient {
  executeUpdate(workflowId: string, updateName: string, args: readonly unknown[]): Promise<unknown>;
}

/** Gate 2 rows (`gate_decisions`), tenant-scoped. Matches `createPgGate2DecisionStore(db).open`. */
export interface ScopeExceptionStore {
  open(
    tenantId: string,
    input: {
      readonly decisionId: string;
      readonly runId: string;
      readonly kind: 'scope_exception';
      readonly dedupeKey: string;
      readonly subtaskId: null;
      readonly sessionId: null;
      readonly toolUseId: null;
      readonly summary: string;
      readonly target: string;
      readonly requestedAt: Date;
      readonly timeoutAt: Date;
    },
  ): Promise<{
    readonly row: {
      readonly decisionId: string;
      readonly status: 'pending' | 'approved' | 'denied';
    };
    readonly created: boolean;
  }>;
}

export interface EngagementAdapters {
  readonly testCases?: TestCaseStatusStore;
  readonly runController?: RunControllerClient;
  readonly scopeExceptions?: ScopeExceptionStore;
  /** Gate 2 timeout: no decision before it is denied by the system (F13). */
  readonly gate2TimeoutMinutes: number;
  readonly newId: () => string;
  readonly now: () => Date;
}

const SUMMARY_MAX = 2000;
const MS_PER_MINUTE = 60_000;

/** Stable answer for a capability with no adapter wired (the broker's NOT_IMPLEMENTED convention). */
function notImplemented(owner: string): AppError {
  return new AppError('NOT_IMPLEMENTED', 'not implemented', {
    detail: `This broker endpoint is owned by ${owner} and is not implemented yet.`,
  });
}

/** The Run Controller's answer, as the update returns it. Extra fields (the session input) are dropped here. */
const runControllerOutcomeSchema = z.discriminatedUnion('accepted', [
  z.object({
    accepted: z.literal(true),
    subtaskId: z.string(),
    status: subtaskStatusSchema,
    created: z.boolean(),
  }),
  z.object({ accepted: z.literal(false), code: z.string(), message: z.string() }),
]);

/**
 * `dispatch_subtask` (ORCH-007): signals the Run Controller. The specialist is started there, in a new
 * sandbox, as a child workflow. Nothing here runs the specialist in-process (§4.2).
 */
export function createRunControllerDispatch(
  client: RunControllerClient,
): (ref: EngagementRef, input: EngagementDispatchInput) => Promise<EngagementDispatchResult> {
  return async (ref, input) => {
    const raw = await client.executeUpdate(
      executionWorkflowId(ref.runId),
      DISPATCH_SUBTASK_UPDATE,
      [input],
    );
    const outcome = runControllerOutcomeSchema.parse(raw);
    if (!outcome.accepted) return { accepted: false, code: outcome.code, message: outcome.message };
    return {
      accepted: true,
      subtaskId: outcome.subtaskId,
      status: outcome.status,
      created: outcome.created,
    };
  };
}

/**
 * `mark_test_case_status` (MCP-012 acceptance): the allowed transitions are enforced here, against the status
 * stored now, and the write is a compare-and-set so a racing change cannot slip past the check.
 */
export async function markTestCaseStatus(
  store: TestCaseStatusStore,
  ref: EngagementRef,
  input: EngagementMarkTestCaseInput,
): Promise<EngagementMarkTestCaseResult> {
  const from = await store.currentStatus(ref, input.testCaseId);
  if (from === null) throw new AppError('NOT_FOUND', 'test case not found');
  if (!canTransitionTestCase(from, input.status)) {
    throw new AppError('INVALID_TRANSITION', 'the test case cannot move to that status', {
      detail: `A test case in status ${from} cannot move to ${input.status}.`,
    });
  }
  const moved = await store.compareAndSet(ref, input.testCaseId, from, input.status, input.reason);
  if (!moved) {
    throw new AppError('INVALID_TRANSITION', 'the test case changed concurrently', {
      detail: 'The status changed while the request was processed; read it again.',
    });
  }
  return { testCaseId: input.testCaseId, status: input.status, previousStatus: from };
}

/**
 * `request_scope_exception` (GATE2): opens a Gate 2 `scope_exception` row. The dedupe key is the target, so a
 * repeat request for an undecided target returns the same row rather than a second approval prompt.
 */
export function createScopeExceptionRequest(
  store: ScopeExceptionStore,
  adapters: Pick<EngagementAdapters, 'gate2TimeoutMinutes' | 'newId' | 'now'>,
): (
  ref: EngagementRef,
  input: EngagementScopeExceptionInput,
) => Promise<EngagementScopeExceptionResult> {
  return async (ref, input) => {
    const requestedAt = adapters.now();
    const timeoutAt = new Date(
      requestedAt.getTime() + adapters.gate2TimeoutMinutes * MS_PER_MINUTE,
    );
    const targetDigest = createHash('sha256').update(input.target).digest('hex');
    const { row } = await store.open(ref.tenantId, {
      decisionId: adapters.newId(),
      runId: ref.runId,
      kind: 'scope_exception',
      dedupeKey: `scope:target:${targetDigest}`,
      subtaskId: null,
      sessionId: null,
      toolUseId: null,
      summary: `${input.target}: ${input.reason}`.slice(0, SUMMARY_MAX),
      target: input.target,
      requestedAt,
      timeoutAt,
    });
    return { decisionId: row.decisionId, gate: 2, status: row.status };
  };
}

/**
 * Builds the engagement port from whichever adapters are wired. Missing adapters answer `NOT_IMPLEMENTED`
 * and the state, open-subtask, result and mentor reads stay owned by ORCH and MENTOR until those land.
 */
export function createEngagementPort(adapters: EngagementAdapters): EngagementPort {
  const dispatch =
    adapters.runController === undefined
      ? undefined
      : createRunControllerDispatch(adapters.runController);
  const scope =
    adapters.scopeExceptions === undefined
      ? undefined
      : createScopeExceptionRequest(adapters.scopeExceptions, adapters);
  return {
    state: () => Promise.reject(notImplemented('ORCH/WORKFLOW')),
    openSubtasks: () => Promise.reject(notImplemented('ORCH')),
    dispatch: (ref, input) =>
      dispatch === undefined
        ? Promise.reject(notImplemented('ORCH/WORKFLOW'))
        : dispatch(ref, input),
    subtaskResult: () => Promise.reject(notImplemented('ORCH')),
    markTestCase: (ref, input) =>
      adapters.testCases === undefined
        ? Promise.reject(notImplemented('ORCH'))
        : markTestCaseStatus(adapters.testCases, ref, input),
    requestMentorReview: () => Promise.reject(notImplemented('MENTOR')),
    requestScopeException: (ref, input) =>
      scope === undefined ? Promise.reject(notImplemented('GATE2')) : scope(ref, input),
  };
}
