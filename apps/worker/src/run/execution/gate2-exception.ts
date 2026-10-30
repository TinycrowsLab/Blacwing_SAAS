// Gate 2 exception activities (GATE2-004, #207). The broker (GATE2-002) persists a `gate2_exceptions` row and signals
// the run; these activities are how the run's workflow reads that row, records a person's decision or the timer's
// timeout, pages the escalation ladder and supersedes pending exceptions on kill. Every decision goes through the
// Gate 2 state machine in `@blackwing/db`: separation of duties, default deny, the timeout guard and the audit event
// are enforced there, not in this workflow.

import {
  Gate2AlreadyDecidedError,
  Gate2DestructiveForbiddenError,
  Gate2SeparationOfDutiesError,
  IllegalGate2TransitionError,
} from '@blackwing/domain';
import { NotFoundError, ValidationError } from '@blackwing/errors';

import type { ExecutionMetrics, Gate2ExceptionStore, Pager } from './ports.js';
import type {
  ExecutionActivities,
  Gate2Decision,
  Gate2ExceptionRefusal,
  Gate2ExceptionVerdict,
} from './types.js';

export interface Gate2ExceptionActivityDeps {
  readonly exceptions: Gate2ExceptionStore;
  readonly pager: Pager;
  readonly metrics: ExecutionMetrics;
}

export type Gate2ExceptionActivities = Pick<
  ExecutionActivities,
  'readGate2Exception' | 'decideGate2Exception' | 'pageGate2Escalation' | 'supersedeGate2Exceptions'
>;

const SYSTEM_ACTOR = { kind: 'system', id: 'gate2-exception-workflow' } as const;

/** The `blackwing_gate2_total` label of an applied event. */
function outcomeOf(
  event: 'approve' | 'deny' | 'time_out' | 'supersede',
): Gate2Decision | 'timeout' {
  switch (event) {
    case 'approve':
      return 'approved';
    case 'time_out':
      return 'timeout';
    case 'deny':
    case 'supersede':
      return 'denied';
  }
}

/** Maps a rule refusal of the state machine to its stable code; `undefined` for anything that is not a refusal. */
export function refusalOf(error: unknown): Gate2ExceptionRefusal | undefined {
  if (error instanceof Gate2SeparationOfDutiesError) return 'GATE2_SOD_VIOLATION';
  if (error instanceof Gate2AlreadyDecidedError) return 'GATE2_ALREADY_DECIDED';
  if (error instanceof Gate2DestructiveForbiddenError) return 'GATE2_DESTRUCTIVE_FORBIDDEN';
  if (error instanceof IllegalGate2TransitionError) return 'GATE2_ILLEGAL_TRANSITION';
  // A malformed decision (for example an empty reason) is refused, never stored.
  if (error instanceof ValidationError) return 'GATE2_ILLEGAL_TRANSITION';
  if (error instanceof NotFoundError) return 'GATE2_NOT_FOUND';
  return undefined;
}

/** Builds the Gate 2 exception activities over their ports. Each one is idempotent under Temporal retries. */
export function createGate2ExceptionActivities(
  deps: Gate2ExceptionActivityDeps,
): Gate2ExceptionActivities {
  return {
    async readGate2Exception({ exceptionId, ...ref }) {
      const row = await deps.exceptions.read(ref.tenantId, ref.runId, exceptionId);
      return row === null ? null : { exceptionId, ...row };
    },

    async decideGate2Exception({ exceptionId, event, actor, reason, ...ref }) {
      const verdict: Gate2ExceptionVerdict = await deps.exceptions.apply(
        ref.tenantId,
        ref.runId,
        exceptionId,
        { event, actor, ...(reason === undefined ? {} : { reason }) },
      );
      // The clock says "not yet" only if the timer and the database disagree. Throw so Temporal retries the
      // activity; the exception stays pending (denied by default) until a timeout is recorded.
      if (verdict.kind === 'refused' && event === 'time_out') {
        throw new Error(`gate 2 timeout refused: ${verdict.code}`);
      }
      if (verdict.kind === 'refused' && event === 'supersede') {
        throw new Error(`gate 2 supersede refused: ${verdict.code}`);
      }
      if (verdict.kind === 'applied') deps.metrics.gate2(outcomeOf(event));
      return verdict;
    },

    async pageGate2Escalation({ exceptionId, level, ...ref }) {
      await deps.pager.page({
        tenantId: ref.tenantId,
        runId: ref.runId,
        message: `Gate 2 exception ${exceptionId} is waiting for a decision (escalation level ${String(level)}).`,
      });
      deps.metrics.gate2Escalation(level);
    },

    async supersedeGate2Exceptions(ref) {
      for (const exceptionId of await deps.exceptions.pendingIds(ref.tenantId, ref.runId)) {
        const verdict = await deps.exceptions.apply(ref.tenantId, ref.runId, exceptionId, {
          event: 'supersede',
          actor: SYSTEM_ACTOR,
        });
        if (verdict.kind === 'refused') {
          throw new Error(`gate 2 supersede refused: ${verdict.code}`);
        }
        if (verdict.kind === 'applied') deps.metrics.gate2('denied');
      }
    },
  };
}
