import { SpanStatusCode, trace } from '@opentelemetry/api';

import { TERMINAL_RUN_STATES } from '@blackwing/contracts';
import { applyTransition, type RunEvent, type RunStatus } from '@blackwing/domain';
import { ConflictError, NotFoundError } from '@blackwing/errors';

import { sanitiseSummary, toSnapshot } from './frontier.js';

import type {
  ActivityRuntime,
  AdvisorySessions,
  ExecutionAuditRecord,
  ExecutionAuditSink,
  ExecutionMetrics,
  ExecutionRunState,
  Gate2Permissions,
  Gate2Row,
  Gate2Store,
  OrchestratorSessions,
  Pager,
  ScopeExceptions,
  SpecialistBranches,
  SubtaskFrontier,
} from './ports.js';
import type {
  ExecutionActivities,
  ExecutionRef,
  FrontierSnapshot,
  Gate2Applied,
  Gate2Decision,
  Gate2Resolution,
  Gate2Verdict,
} from './types.js';
import type { Logger } from '@blackwing/logger';

export interface ExecutionActivityDeps {
  readonly runs: ExecutionRunState;
  readonly orchestrator: OrchestratorSessions;
  readonly frontier: SubtaskFrontier;
  readonly branches: SpecialistBranches;
  readonly gates: Gate2Store;
  readonly permissions: Gate2Permissions;
  readonly scopeExceptions: ScopeExceptions;
  readonly advisors: AdvisorySessions;
  readonly pager: Pager;
  readonly audit: ExecutionAuditSink;
  readonly metrics: ExecutionMetrics;
  readonly log: Logger;
  /** Heartbeat and cancellation of the running activity (see `temporalActivityRuntime`). */
  readonly activity: () => ActivityRuntime;
  /** Heartbeat period while the orchestrator runs; must be well under the workflow's heartbeat timeout. */
  readonly heartbeatMs?: number;
  readonly now?: () => Date;
}

const tracer = trace.getTracer('@blackwing/worker');
const SYSTEM = { kind: 'system', id: 'execution-workflow' } as const;
const DEFAULT_HEARTBEAT_MS = 10_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
const DISPATCH_TOOL_SUFFIX = '__dispatch_subtask';
const PARALLEL_BATCH_REASON =
  'PARALLEL_BATCH_OUT_OF_ENVELOPE: this call is outside the approved envelope and was part of a parallel tool batch; retry it alone to request a Gate 2 exception';

/**
 * Builds the execution-phase activities over their ports (ORCH-008). Every activity is idempotent: a
 * retry after a crash re-reads the persisted state, applies only what is missing and appends audit
 * events under stable dedupe keys. Refusals (no permission, SoD, already decided) are values, never
 * thrown, so Temporal does not retry a definitive answer; only a port that cannot answer throws.
 *
 * Gate 2 fails closed: nothing is allowed unless a different, authorised human approved it before the
 * timeout. The timeout, a cancellation and a kill all decide `denied`. The mentor and reflector are
 * advice only: nothing here consults them to allow an action (§8.11).
 */
export function createExecutionActivities(deps: ExecutionActivityDeps): ExecutionActivities {
  const now = deps.now ?? ((): Date => new Date());
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  async function audit(
    action: ExecutionAuditRecord['action'],
    ref: ExecutionRef,
    key: string,
    actorId: string | null,
    outcome: 'success' | 'failure',
    metadata: ExecutionAuditRecord['metadata'],
  ): Promise<void> {
    await deps.audit.append({
      action,
      outcome,
      ...ref,
      actorId,
      occurredAt: now().toISOString(),
      dedupeKey: `${ref.runId}:${action}:${key}`,
      metadata,
    });
  }

  /** Applies a state-machine event; a run already in the target state is left alone so retries are no-ops. */
  async function transition(
    ref: ExecutionRef,
    event: RunEvent,
    to: RunStatus['state'],
    actor: { readonly kind: 'user' | 'system'; readonly id: string } = SYSTEM,
  ): Promise<void> {
    const facts = await deps.runs.load(ref.tenantId, ref.runId);
    if (facts === null) throw new NotFoundError('Run not found for tenant');
    if (facts.status.state === to) return;
    const result = applyTransition(facts.status, event, {
      actor,
      ...(facts.requestedBy === null ? {} : { requestedBy: facts.requestedBy }),
      envelopeValid: facts.envelopeValid,
    });
    const saved = await deps.runs.save(ref.tenantId, ref.runId, facts.status.version, result.next);
    // A lost race is retried by Temporal; the reload then sees the other writer's state.
    if (!saved) throw new ConflictError('Run state changed concurrently', { detail: 'retry' });
    if (result.auditIntent !== null) {
      await audit('run.state_changed', ref, `${result.next.version}`, actor.id, 'success', {
        event: event.type,
        from: result.auditIntent.from,
        to: result.auditIntent.to,
        ...(event.type === 'pause' ? { reason: event.reason } : {}),
      });
    }
  }

  async function snapshot(ref: ExecutionRef): Promise<FrontierSnapshot> {
    const facts = await deps.runs.load(ref.tenantId, ref.runId);
    if (facts === null) throw new NotFoundError('Run not found for tenant');
    const counts = await deps.frontier.snapshot(ref.tenantId, ref.runId);
    return toSnapshot(counts, TERMINAL_RUN_STATES.includes(facts.status.state));
  }

  /** Compare-and-set decision plus its audit and metrics; returns what the row ends up as. */
  async function settle(
    ref: ExecutionRef,
    row: Gate2Row,
    resolution: Gate2Resolution,
  ): Promise<Gate2Verdict> {
    const human = resolution.kind === 'human';
    const decision: Gate2Decision = human ? resolution.decision : 'denied';
    const decidedBy = human ? resolution.actorId : null;
    const reason = human
      ? sanitiseSummary(resolution.reason ?? '')
      : resolution.kind === 'timeout'
        ? 'GATE2_TIMEOUT'
        : 'GATE2_CANCELLED';
    const decidedAt = now();
    const changed = await deps.gates.decide(ref.tenantId, row.decisionId, {
      decision,
      decidedBy,
      decidedAt: decidedAt.toISOString(),
      reason,
      auto: !human,
    });
    if (!changed) {
      const current = await deps.gates.get(ref.tenantId, row.decisionId);
      if (current === null) throw new NotFoundError('Gate 2 decision not found for tenant');
      return alreadyDecided(ref, current, resolution);
    }
    deps.metrics.gate2(resolution.kind === 'timeout' ? 'timeout' : decision);
    deps.metrics.gate2Wait(
      Math.max(0, (decidedAt.getTime() - Date.parse(row.requestedAt)) / MS_PER_SECOND),
    );
    await audit('gate2.decided', ref, row.decisionId, decidedBy, 'success', {
      decisionId: row.decisionId,
      kind: row.request.kind,
      decision,
      auto: !human,
      reason,
    });
    deps.log.info(
      { runId: ref.runId, decisionId: row.decisionId, decision, auto: !human },
      'gate2 decided',
    );
    return { accepted: true, decision, auto: !human };
  }

  function alreadyDecided(
    ref: ExecutionRef,
    row: Gate2Row,
    resolution: Gate2Resolution,
  ): Promise<Gate2Verdict> {
    if (row.status === 'pending') throw new ConflictError('Gate 2 decision is still pending');
    // The clock or a kill racing a human: whoever decided first stands, and the loser sees it.
    if (resolution.kind !== 'human') {
      return Promise.resolve({ accepted: true, decision: row.status, auto: row.auto });
    }
    return refuse(ref, row.decisionId, resolution.actorId, 'GATE2_ALREADY_DECIDED');
  }

  async function refuse(
    ref: ExecutionRef,
    decisionId: string,
    actorId: string,
    code:
      'GATE2_NOT_FOUND' | 'GATE2_ALREADY_DECIDED' | 'GATE2_SOD_VIOLATION' | 'GATE2_NOT_PERMITTED',
  ): Promise<Gate2Verdict> {
    await audit(
      'gate2.decided',
      ref,
      `refused:${decisionId}:${actorId}:${code}`,
      actorId,
      'failure',
      {
        decisionId,
        code,
      },
    );
    deps.log.warn({ runId: ref.runId, decisionId, actorId, code }, 'gate2 decision refused');
    return { accepted: false, code };
  }

  return {
    async beginExecution(ref) {
      const facts = await deps.runs.load(ref.tenantId, ref.runId);
      if (facts === null) throw new NotFoundError('Run not found for tenant');
      // `approved` -> `executing`; a run already executing (workflow restart) or paused is left as is.
      if (facts.status.state === 'approved') {
        await transition(ref, { type: 'execution_started' }, 'executing');
      }
      return snapshot(ref);
    },

    async startOrchestrator(ref) {
      const { sessionId } = await deps.orchestrator.start(ref.tenantId, ref.runId);
      await audit('orchestrator.started', ref, sessionId, null, 'success', { sessionId });
      deps.log.info({ runId: ref.runId, sessionId }, 'orchestrator started');
      return { sessionId };
    },

    superviseOrchestrator({ sessionId, ...ref }) {
      return tracer.startActiveSpan('orchestrator.session', async (span) => {
        const activity = deps.activity();
        const timer = setInterval(() => {
          activity.heartbeat();
        }, heartbeatMs);
        try {
          activity.heartbeat();
          const stopReason = await deps.orchestrator.run(
            { ...ref, sessionId },
            {
              onToolUse: (toolName) => {
                if (toolName.endsWith(DISPATCH_TOOL_SUFFIX)) deps.metrics.dispatch();
              },
            },
            activity.cancellationSignal,
          );
          span.setAttribute('orchestrator.stop_reason', stopReason);
          deps.log.info({ runId: ref.runId, sessionId, stopReason }, 'orchestrator stopped');
          return { stopReason };
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          deps.log.warn({ runId: ref.runId, sessionId, err }, 'orchestrator session failed');
          throw err;
        } finally {
          clearInterval(timer);
          span.end();
        }
      });
    },

    async stopOrchestrator(ref) {
      await deps.orchestrator.stop(ref.tenantId, ref.runId);
    },

    async observeFrontier(ref) {
      const snap = await snapshot(ref);
      const pending = (await deps.gates.listPending(ref.tenantId, ref.runId)).length;
      deps.log.info(
        {
          runId: ref.runId,
          openSubtasks: snap.open + snap.eligible,
          inFlight: snap.inFlight,
          gate2Pending: pending,
        },
        'frontier observed',
      );
      return snap;
    },

    openGate2({ request, timeoutMinutes, ...ref }) {
      return tracer.startActiveSpan('gate2.wait', async (span) => {
        try {
          const requestedAt = now();
          const timeoutAt = new Date(requestedAt.getTime() + timeoutMinutes * MS_PER_MINUTE);
          const { row } = await deps.gates.open(
            ref.tenantId,
            ref.runId,
            { ...request, summary: sanitiseSummary(request.summary) },
            timeoutAt.toISOString(),
            requestedAt.toISOString(),
          );
          span.setAttribute('gate2.decision_id', row.decisionId);
          // Paged on every attempt while pending: a retry after a crash must never leave on-call unaware.
          if (row.status === 'pending') {
            await deps.pager.page({
              ...ref,
              message: `Gate 2: ${row.request.kind === 'scope_exception' ? 'scope exception' : 'out-of-envelope call'} awaiting a decision (denied automatically at ${row.timeoutAt}): ${row.request.summary}`,
            });
          }
          await audit('gate2.opened', ref, row.decisionId, null, 'success', {
            decisionId: row.decisionId,
            kind: row.request.kind,
            subtaskId: row.request.subtaskId,
            timeoutAt: row.timeoutAt,
          });
          if (row.request.kind === 'scope_exception') {
            await audit('scope_exception.requested', ref, row.request.dedupeKey, null, 'success', {
              decisionId: row.decisionId,
              subtaskId: row.request.subtaskId,
              target: row.request.target,
            });
          }
          const pending = (await deps.gates.listPending(ref.tenantId, ref.runId)).length;
          deps.log.info(
            { runId: ref.runId, decisionId: row.decisionId, gate2Pending: pending },
            'gate2 opened',
          );
          return { decisionId: row.decisionId };
        } finally {
          span.end();
        }
      });
    },

    async decideGate2({ decisionId, resolution, ...ref }) {
      const row = await deps.gates.get(ref.tenantId, decisionId);
      if (row === null) {
        return refuse(
          ref,
          decisionId,
          resolution.kind === 'human' ? resolution.actorId : 'system',
          'GATE2_NOT_FOUND',
        );
      }
      if (row.status !== 'pending') return alreadyDecided(ref, row, resolution);
      if (resolution.kind === 'human') {
        const facts = await deps.runs.load(ref.tenantId, ref.runId);
        if (facts === null) throw new NotFoundError('Run not found for tenant');
        // §8.4 SoD: an unknown requester also fails closed.
        if (facts.requestedBy === null || facts.requestedBy === resolution.actorId) {
          return refuse(ref, decisionId, resolution.actorId, 'GATE2_SOD_VIOLATION');
        }
        if (!(await deps.permissions.canDecide(ref.tenantId, resolution.actorId))) {
          return refuse(ref, decisionId, resolution.actorId, 'GATE2_NOT_PERMITTED');
        }
      }
      return settle(ref, row, resolution);
    },

    async applyGate2({ decisionId, ...ref }): Promise<Gate2Applied> {
      const row = await deps.gates.get(ref.tenantId, decisionId);
      if (row === null) throw new NotFoundError('Gate 2 decision not found for tenant');
      // Only a stored decision is ever applied; a pending row means the workflow raced its own write.
      if (row.status === 'pending') throw new ConflictError('Gate 2 decision is still pending');
      const decision = row.status;
      const { request } = row;

      if (request.kind === 'scope_exception') {
        await deps.scopeExceptions.resolve({
          ...ref,
          decisionId,
          target: request.target ?? '',
          decision,
          decidedBy: row.decidedBy,
        });
        return { resumed: false, requeued: false };
      }

      if (request.sessionId === null || request.toolUseId === null || request.subtaskId === null) {
        throw new ConflictError('Deferred Gate 2 decision has no session to resume');
      }
      const outcome = await deps.branches.resumeDeferred({
        ...ref,
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        decision,
        reason: row.reason ?? '',
      });
      if (outcome === 'resumed') return { resumed: true, requeued: false };

      // The session timed out before the human answered: an approval is honoured by dispatching the
      // subtask again; a denial just ends it.
      if (decision === 'approved') {
        await deps.branches.requeue(ref.tenantId, ref.runId, request.subtaskId);
        deps.log.warn({ runId: ref.runId, decisionId }, 'session expired, subtask re-dispatched');
        return { resumed: false, requeued: true };
      }
      await deps.branches.markBlocked(ref.tenantId, ref.runId, request.subtaskId, 'GATE2_DENIED');
      return { resumed: false, requeued: false };
    },

    async denyAndPauseBranch({ event, ...ref }) {
      await deps.branches.denyAndPause({
        ...ref,
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        reason: PARALLEL_BATCH_REASON,
      });
      await deps.branches.markBlocked(
        ref.tenantId,
        ref.runId,
        event.subtaskId,
        'PARALLEL_BATCH_DENIED',
      );
      await audit('branch.paused', ref, event.toolUseId, null, 'success', {
        subtaskId: event.subtaskId,
        sessionId: event.sessionId,
        toolName: sanitiseSummary(event.toolName),
        toolCallsInTurn: event.toolCallsInTurn,
        reason: 'PARALLEL_BATCH_DENIED',
      });
      deps.log.warn(
        { runId: ref.runId, sessionId: event.sessionId, subtaskId: event.subtaskId },
        'parallel-batch out-of-envelope call denied, branch paused',
      );
    },

    async requestMentor({ reason, reflector, key, ...ref }) {
      await audit('mentor.requested', ref, `${key}:mentor`, null, 'success', {
        key,
        reason,
        role: 'mentor',
      });
      await deps.advisors.run({ ...ref, role: 'mentor', reason });
      deps.metrics.mentorIntervention('mentor');
      if (reflector) {
        await audit('mentor.requested', ref, `${key}:reflector`, null, 'success', {
          key,
          reason,
          role: 'reflector',
        });
        await deps.advisors.run({ ...ref, role: 'reflector', reason });
        deps.metrics.mentorIntervention('reflector');
      }
    },

    async pauseRun({ reason, ...ref }) {
      await transition(ref, { type: 'pause', reason }, 'paused');
      await deps.pager.page({
        ...ref,
        message:
          reason === 'operator_pause'
            ? 'Execution is paused: the orchestrator is not making progress after mentor intervention'
            : 'Execution is paused: the orchestrator exhausted its budget',
      });
    },

    async resumeRun({ actorId, ...ref }) {
      await transition(ref, { type: 'resume' }, 'executing', { kind: 'user', id: actorId });
    },

    async completeExecution(ref) {
      // Checked at the transition itself, so no caller can complete a phase with work remaining.
      const snap = await snapshot(ref);
      if (!snap.exhausted) return { completed: false, code: 'FRONTIER_NOT_EXHAUSTED' };
      await transition(ref, { type: 'validation_started' }, 'validating');
      await audit('execution.completed', ref, 'run', null, 'success', {
        terminalSubtasks: snap.terminal,
      });
      deps.log.info({ runId: ref.runId, openSubtasks: 0 }, 'execution completed');
      return { completed: true };
    },

    async abortExecution(ref) {
      await deps.orchestrator.stop(ref.tenantId, ref.runId);
      await deps.branches.cancelAll(ref.tenantId, ref.runId);
      // Nothing may stay approvable once its session is gone.
      for (const row of await deps.gates.listPending(ref.tenantId, ref.runId)) {
        await settle(ref, row, { kind: 'cancelled' });
      }
    },
  };
}
