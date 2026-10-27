import { createHash } from 'node:crypto';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { canonicalJson, testPlanJsonSchema } from '@blackwing/contracts';
import { applyTransition, isTerminal, type RunEvent, type RunStatus } from '@blackwing/domain';
import { ConflictError, NotFoundError } from '@blackwing/errors';

import { evaluateAutoApproval } from './auto-approval.js';
import { checkPlan } from './plan-check.js';
import { gate1DecisionSignalSchema } from './signal.js';

import type {
  Gate1DecisionRecord,
  Gate1Permissions,
  GateDecisions,
  PlannerSessions,
  PlanningAuditRecord,
  PlanningAuditSink,
  PlanningMetrics,
  PlanningRunFacts,
  PlanningRunState,
  PlanStore,
  RunEnvelopes,
  StandingAuthorisations,
  StoredPlan,
} from './ports.js';
import type { Gate1RefusalCode, Gate1Verdict, PlanningActivities, PlanningRef } from './types.js';
import type { Pager } from '../postexec/ports.js';
import type { Logger } from '@blackwing/logger';

export interface PlanningActivityDeps {
  readonly runs: PlanningRunState;
  readonly sas: StandingAuthorisations;
  readonly plans: PlanStore;
  readonly decisions: GateDecisions;
  readonly envelopes: RunEnvelopes;
  readonly planner: PlannerSessions;
  readonly permissions: Gate1Permissions;
  readonly pager: Pager;
  readonly audit: PlanningAuditSink;
  readonly metrics: PlanningMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
}

const tracer = trace.getTracer('@blackwing/worker');
const SYSTEM = { kind: 'system', id: 'planning-workflow' } as const;
const MS_PER_SECOND = 1000;

interface Actor {
  readonly kind: 'user' | 'system';
  readonly id: string;
}

/**
 * Builds the planning activities over their ports (ORCH-005). Every activity is idempotent: a retry
 * re-reads the persisted state, applies only what is missing and appends audit events under stable
 * dedupe keys. Refusals (SoD, permission, stale plan, expired SA) are values, never thrown, so Temporal
 * does not retry a definitive answer; only a port that cannot answer throws.
 *
 * Gate 1 safety is deterministic code (§8.11): the planner's output is validated data, auto-approval is
 * re-evaluated here from the stored plan and the SA (`evaluateAutoApproval`), a `state_changing` case
 * always needs a human, and the approver is checked against the requester (§8.4) on every decision.
 */
export function createPlanningActivities(deps: PlanningActivityDeps): PlanningActivities {
  const now = deps.now ?? ((): Date => new Date());

  async function audit(
    action: PlanningAuditRecord['action'],
    ref: PlanningRef,
    key: string,
    actorId: string | null,
    outcome: 'success' | 'failure',
    metadata: PlanningAuditRecord['metadata'],
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

  async function loadRun(ref: PlanningRef): Promise<PlanningRunFacts> {
    const facts = await deps.runs.load(ref.tenantId, ref.runId);
    if (facts === null) throw new NotFoundError('Run not found for tenant');
    return facts;
  }

  /** Applies a state-machine event; a run already in `to` is left alone so retries are no-ops. */
  async function transition(
    ref: PlanningRef,
    event: RunEvent,
    to: RunStatus['state'],
    actor: Actor = SYSTEM,
    autoApproved = false,
  ): Promise<boolean> {
    const facts = await loadRun(ref);
    if (facts.status.state === to) return false;
    const result = applyTransition(facts.status, event, {
      actor,
      ...(facts.requestedBy === null ? {} : { requestedBy: facts.requestedBy }),
      ...(autoApproved ? { autoApproved } : {}),
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
      });
    }
    return true;
  }

  /**
   * Freezes the plan version, writes the immutable approved run envelope (§8.9), records the gate
   * decision and moves the run to `approved`. The envelope exists before the state does, so no run is
   * ever `approved` without one. Returns false when the plan was edited after it was reviewed.
   */
  async function approve(
    ref: PlanningRef,
    facts: PlanningRunFacts,
    plan: StoredPlan,
    approver: { readonly actorId: string | null; readonly reason: string },
  ): Promise<boolean> {
    const auto = approver.actorId === null;
    if (
      (await deps.plans.freeze(ref.tenantId, ref.runId, plan.planId, plan.version)) === 'conflict'
    ) {
      return false;
    }
    const at = now().toISOString();
    const body = {
      tenantId: ref.tenantId,
      runId: ref.runId,
      planId: plan.planId,
      planVersion: plan.version,
      saId: facts.saId,
      pins: facts.runManifest ?? {},
      approvedBy: approver.actorId,
      auto,
      frozenAt: at,
    };
    const envelopeHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
    await deps.envelopes.freeze({ ...body, envelopeHash });
    await deps.decisions.record({
      ...ref,
      planId: plan.planId,
      planVersion: plan.version,
      decision: 'approved',
      actorId: approver.actorId,
      auto,
      reason: approver.reason,
      decidedAt: at,
    } satisfies Gate1DecisionRecord);
    await audit('gate1.decided', ref, `v${plan.version}`, approver.actorId, 'success', {
      decision: 'approved',
      auto,
      planVersion: plan.version,
      saId: facts.saId,
      reason: approver.reason,
      envelopeHash,
    });
    const moved = await transition(
      ref,
      { type: 'gate1_approved' },
      'approved',
      approver.actorId === null ? SYSTEM : { kind: 'user', id: approver.actorId },
      auto,
    );
    // Counted by the attempt that moved the run, so a crash-and-retry neither drops nor repeats it.
    if (moved) deps.metrics.gate1Decision('approved', auto);
    deps.log.info(
      {
        runId: ref.runId,
        planVersion: plan.version,
        testCaseCount: plan.testCases.length,
        autoApproved: auto,
      },
      'gate 1 approved',
    );
    return true;
  }

  return {
    proposePlan({ round, attempt, feedback, ...ref }) {
      return tracer.startActiveSpan('planning.propose', async (span) => {
        try {
          const facts = await loadRun(ref);
          const sa = await deps.sas.load(ref.tenantId, facts.saId);
          if (sa === null) throw new NotFoundError('Standing authorisation not found for tenant');
          const raw = await deps.planner.propose({
            ...ref,
            round,
            attempt,
            ...(feedback === undefined ? {} : { feedback }),
            outputFormat: { type: 'json_schema', schema: testPlanJsonSchema() },
          });
          const checked = checkPlan(raw, sa);
          if (!checked.ok) {
            await audit('plan.proposed', ref, `r${round}a${attempt}`, null, 'failure', {
              round,
              attempt,
              code: checked.code,
            });
            deps.log.warn(
              { runId: ref.runId, round, attempt, code: checked.code },
              'planner output rejected',
            );
            span.setAttribute('planning.rejected', checked.code);
            return { outcome: 'rejected' as const, code: checked.code, detail: checked.detail };
          }
          const saved = await deps.plans.save({
            ...ref,
            round,
            testCases: checked.testCases,
          });
          await audit('plan.proposed', ref, `v${saved.version}`, null, 'success', {
            planId: saved.planId,
            planVersion: saved.version,
            testCaseCount: checked.testCases.length,
          });
          if (saved.created) {
            const perClass = new Map<string, number>();
            for (const testCase of checked.testCases) {
              perClass.set(testCase.class, (perClass.get(testCase.class) ?? 0) + 1);
            }
            for (const [testClass, count] of perClass) deps.metrics.testCases(testClass, count);
          }
          deps.log.info(
            {
              runId: ref.runId,
              planVersion: saved.version,
              testCaseCount: checked.testCases.length,
            },
            'plan proposed',
          );
          return {
            outcome: 'persisted' as const,
            planId: saved.planId,
            version: saved.version,
            testCaseCount: checked.testCases.length,
          };
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async failPlanning({ code, ...ref }) {
      await transition(ref, { type: 'fail' }, 'failed');
      await audit('plan.proposed', ref, `failed:${code}`, null, 'failure', { code });
      deps.log.warn({ runId: ref.runId, code }, 'planning failed');
    },

    async requestGate1({ planId, version, ...ref }) {
      await transition(ref, { type: 'plan_proposed' }, 'awaiting_gate1');
      const requestedAt = now().toISOString();
      await audit('gate1.requested', ref, `v${version}`, null, 'success', {
        planId,
        planVersion: version,
      });
      return { requestedAt };
    },

    async autoApprove({ planId, version, ...ref }) {
      const facts = await loadRun(ref);
      if (facts.status.state === 'approved') return { approved: true };
      if (facts.status.state !== 'awaiting_gate1') return { approved: false };
      const plan = await deps.plans.latest(ref.tenantId, ref.runId);
      if (plan?.planId !== planId || plan.version !== version) return { approved: false };
      const sa = await deps.sas.load(ref.tenantId, facts.saId);
      if (sa === null) return { approved: false };
      const decision = evaluateAutoApproval(plan.testCases, sa, now());
      if (!decision.eligible) {
        deps.log.info(
          {
            runId: ref.runId,
            planVersion: version,
            autoApproved: false,
            blockers: decision.blockers,
          },
          'plan needs a human at gate 1',
        );
        return { approved: false };
      }
      const approved = await approve(ref, facts, plan, {
        actorId: null,
        reason: `approved under SA-${sa.id}`,
      });
      return { approved };
    },

    decideGate1({ signal: rawSignal, requestedAt, ...ref }) {
      return tracer.startActiveSpan('gate1.decide', async (span) => {
        try {
          const verdict = await decide(ref, rawSignal, requestedAt);
          span.setAttribute('gate1.accepted', verdict.accepted);
          return verdict;
        } finally {
          span.end();
        }
      });
    },

    async pageGate1Timeout({ page, ...ref }) {
      await deps.pager.page({
        ...ref,
        message: 'Gate 1 is still waiting for an approver to decide the test plan',
      });
      await audit('gate1.decided', ref, `timeout:${page}`, null, 'failure', {
        decision: 'timeout_paged',
        page,
      });
    },

    async abortPlanning(ref) {
      await deps.planner.abort(ref.tenantId, ref.runId);
    },
  };

  async function decide(
    ref: PlanningRef,
    rawSignal: unknown,
    requestedAt: string,
  ): Promise<Gate1Verdict> {
    const parsed = gate1DecisionSignalSchema.safeParse(rawSignal);
    const refuse = async (
      code: Gate1RefusalCode,
      actorId: string | null,
      extra: { terminal?: boolean; runState?: string } = {},
    ): Promise<Gate1Verdict> => {
      await audit(
        'gate1.decided',
        ref,
        `refused:${actorId ?? 'unknown'}:${code}`,
        actorId,
        'failure',
        {
          code,
        },
      );
      deps.log.warn({ runId: ref.runId, actorId, code }, 'gate1 decision refused');
      return {
        accepted: false,
        code,
        terminal: extra.terminal ?? false,
        ...(extra.runState === undefined ? {} : { runState: extra.runState }),
      };
    };
    if (!parsed.success) return refuse('GATE1_SIGNAL_INVALID', null);
    const signal = parsed.data;

    const facts = await loadRun(ref);
    const state = facts.status.state;
    if (state !== 'awaiting_gate1') {
      return refuse('GATE1_RUN_NOT_AWAITING', signal.actorId, {
        terminal: isTerminal(state),
        runState: state,
      });
    }
    // §8.4 SoD: an unknown requester also fails closed.
    if (facts.requestedBy === null || facts.requestedBy === signal.actorId) {
      return refuse('SOD_VIOLATION', signal.actorId);
    }
    if (!(await deps.permissions.canApprove(ref.tenantId, signal.actorId))) {
      return refuse('FORBIDDEN', signal.actorId);
    }

    const plan = await deps.plans.latest(ref.tenantId, ref.runId);
    if (plan?.version !== signal.planVersion) {
      return refuse('PLAN_VERSION_CONFLICT', signal.actorId);
    }
    const actor: Actor = { kind: 'user', id: signal.actorId };
    const waitedSeconds = Math.max(0, now().getTime() - Date.parse(requestedAt)) / MS_PER_SECOND;

    if (signal.decision === 'approved') {
      const sa = await deps.sas.load(ref.tenantId, facts.saId);
      if (sa?.status !== 'active') return refuse('SA_NOT_ACTIVE', signal.actorId);
      if (Date.parse(sa.expiresAt) <= now().getTime()) {
        // An approval after the SA expired is refused and the run moves to `expired`.
        await transition(ref, { type: 'sa_expired' }, 'expired');
        return refuse('SA_EXPIRED', signal.actorId, { terminal: true });
      }
      const approved = await approve(ref, facts, plan, {
        actorId: signal.actorId,
        reason: signal.reason ?? 'approved',
      });
      if (!approved) return refuse('PLAN_VERSION_CONFLICT', signal.actorId);
      deps.metrics.gate1Wait(waitedSeconds);
      return { accepted: true, outcome: 'approved' };
    }

    await deps.decisions.record({
      ...ref,
      planId: plan.planId,
      planVersion: plan.version,
      decision: 'rejected',
      actorId: signal.actorId,
      auto: false,
      reason: signal.reason,
      decidedAt: now().toISOString(),
    });
    await deps.plans.reject(ref.tenantId, ref.runId, plan.planId);
    await audit('gate1.decided', ref, `v${plan.version}`, signal.actorId, 'success', {
      decision: 'rejected',
      auto: false,
      planVersion: plan.version,
      next: signal.next,
      reason: signal.reason,
    });
    const moved =
      signal.next === 'replan'
        ? await transition(ref, { type: 'gate1_replan' }, 'planning', actor)
        : await transition(ref, { type: 'gate1_rejected' }, 'cancelled', actor);
    if (moved) deps.metrics.gate1Decision('rejected', false);
    deps.metrics.gate1Wait(waitedSeconds);
    deps.log.info(
      {
        runId: ref.runId,
        planVersion: plan.version,
        testCaseCount: plan.testCases.length,
        autoApproved: false,
      },
      'gate 1 rejected',
    );
    return { accepted: true, outcome: signal.next === 'replan' ? 'replan' : 'cancelled' };
  }
}
