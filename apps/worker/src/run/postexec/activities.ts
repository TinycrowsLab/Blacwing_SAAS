import { SpanStatusCode, trace } from '@opentelemetry/api';

import { applyTransition, type RunEvent, type RunStatus } from '@blackwing/domain';
import { ConflictError, NotFoundError } from '@blackwing/errors';

import { acceptedRiskValid, classifyVerdict, dedupeDecisions } from './classify.js';

import type {
  CoverageManifest,
  Gate3Permissions,
  Pager,
  PostExecutionAuditRecord,
  PostExecutionAuditSink,
  PostExecutionFindingRepo,
  PostExecutionMetrics,
  PostExecutionRunState,
  Validator,
  WriteUpSessions,
} from './ports.js';
import type {
  CandidateOutcome,
  Gate3Verdict,
  PostExecutionActivities,
  PostExecutionRef,
  Refusal,
} from './types.js';
import type { Logger } from '@blackwing/logger';

export interface PostExecutionActivityDeps {
  readonly findings: PostExecutionFindingRepo;
  readonly runs: PostExecutionRunState;
  readonly validator: Validator;
  readonly sessions: WriteUpSessions;
  readonly coverage: CoverageManifest;
  readonly permissions: Gate3Permissions;
  readonly pager: Pager;
  readonly audit: PostExecutionAuditSink;
  readonly metrics: PostExecutionMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
}

const tracer = trace.getTracer('@blackwing/worker');
const SYSTEM = { kind: 'system', id: 'post-execution-workflow' } as const;

/**
 * Builds the post-execution activities over their ports (ORCH-009). Every activity is idempotent: a
 * retry after a crash re-reads the persisted state, applies only what is missing and appends audit
 * events under stable dedupe keys. Refusals (no permission, SoD, bad decision) are values, never
 * thrown, so Temporal does not retry a definitive answer; only a port that cannot answer throws.
 *
 * Validation judgement stays in VALIDATE: this routes the verdict, and the confirmed/suspected split
 * is the deterministic `classifyVerdict`. A suspected finding is never offered to Gate 3: `decideGate3`
 * only acts on `confirmed` findings, and the only way out of `suspected` is `recordOutcome` from a
 * successful re-validation.
 */
export function createPostExecutionActivities(
  deps: PostExecutionActivityDeps,
): PostExecutionActivities {
  const now = deps.now ?? ((): Date => new Date());

  async function audit(
    action: PostExecutionAuditRecord['action'],
    ref: PostExecutionRef,
    key: string,
    actorId: string | null,
    outcome: 'success' | 'failure',
    metadata: PostExecutionAuditRecord['metadata'],
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

  /** Applies a state-machine event; a run already past it is left alone so retries are no-ops. */
  async function transition(
    ref: PostExecutionRef,
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
      });
    }
  }

  async function confirmedPending(ref: PostExecutionRef): Promise<number> {
    const all = await deps.findings.list(ref.tenantId, ref.runId);
    return all.filter((f) => f.status === 'confirmed').length;
  }

  return {
    async startValidation(ref) {
      await transition(ref, { type: 'validation_started' }, 'validating');
      const candidateIds = await deps.findings.listUnresolved(ref.tenantId, ref.runId);
      await audit('validation.started', ref, 'run', null, 'success', {
        candidates: candidateIds.length,
      });
      deps.log.info({ runId: ref.runId, candidates: candidateIds.length }, 'validation started');
      return { candidateIds };
    },

    validateCandidate({ findingId, ...ref }) {
      return tracer.startActiveSpan('validation.candidate', async (span) => {
        try {
          const verdict = await deps.validator.validate({ ...ref, findingId });
          const outcome = classifyVerdict(findingId, verdict);
          span.setAttribute('validation.result', outcome.outcome);
          deps.log.info(
            { runId: ref.runId, candidateId: findingId, result: outcome.outcome },
            'candidate validated',
          );
          return outcome;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          deps.log.warn({ runId: ref.runId, candidateId: findingId, result: 'error', err });
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async recordOutcome({ outcome, ...ref }) {
      const changed = await deps.findings.recordOutcome(ref.tenantId, ref.runId, toRecord(outcome));
      // `changed` is false on a retry that already persisted: audit and metric are still safe to repeat
      // (dedupe key), but the counter must not double count.
      const action = outcome.outcome === 'confirmed' ? 'finding.confirmed' : 'finding.suspected';
      await audit(action, ref, outcome.findingId, null, 'success', {
        findingId: outcome.findingId,
        ...(outcome.outcome === 'suspected' ? { reason: outcome.reason } : {}),
      });
      if (changed) deps.metrics.candidate(outcome.outcome);
      deps.log.info(
        { runId: ref.runId, findingId: outcome.findingId, result: outcome.outcome },
        'candidate outcome recorded',
      );
    },

    async requestGate3(ref) {
      await transition(ref, { type: 'gate3_requested' }, 'awaiting_gate3');
      return { pending: await confirmedPending(ref) };
    },

    decideGate3({ signal, ...ref }) {
      return tracer.startActiveSpan('gate3.decide', async (span) => {
        try {
          const verdict = await decide(ref, signal);
          span.setAttribute('gate3.accepted', verdict.accepted);
          return verdict;
        } finally {
          span.end();
        }
      });
    },

    async pageGate3Timeout({ page, ...ref }) {
      await deps.pager.page({
        ...ref,
        message: 'Gate 3 is still waiting for an analyst to decide the confirmed findings',
      });
      await audit('gate3.decided', ref, `timeout:${page}`, null, 'failure', {
        decision: 'timeout_paged',
        page,
      });
    },

    async startReporting(ref) {
      await transition(ref, { type: 'reporting_started' }, 'reporting');
    },

    async runWriteUp({ role, ...ref }) {
      const all = await deps.findings.list(ref.tenantId, ref.runId);
      const findingIds = all.filter((f) => f.status === 'released').map((f) => f.findingId);
      await deps.sessions.run({ ...ref, role, findingIds });
      if (role === 'reporter') {
        await audit('report.generated', ref, 'reporter', null, 'success', {
          findings: findingIds.length,
        });
      }
    },

    async finaliseCoverage(ref) {
      await deps.coverage.finalise(ref.tenantId, ref.runId);
    },

    async completeRun(ref) {
      // F19: the report cannot complete without a finalised coverage manifest. Checked here, at the
      // transition itself, so no caller can skip it.
      if (!(await deps.coverage.isFinalised(ref.tenantId, ref.runId))) {
        return { completed: false, code: 'COVERAGE_NOT_FINALISED' };
      }
      await transition(ref, { type: 'completed' }, 'completed');
      return { completed: true };
    },

    async abortValidation(ref) {
      await deps.validator.abortRun(ref.tenantId, ref.runId);
    },
  };

  async function decide(
    ref: PostExecutionRef,
    signal: Parameters<PostExecutionActivities['decideGate3']>[0]['signal'],
  ): Promise<Gate3Verdict> {
    const actor = { kind: 'user', id: signal.actorId } as const;
    const refuse = async (
      code: 'GATE3_NOT_PERMITTED' | 'GATE3_SOD_VIOLATION' | 'GATE3_RUN_NOT_AWAITING',
    ): Promise<Gate3Verdict> => {
      await audit(
        'gate3.decided',
        ref,
        `refused:${signal.actorId}:${code}`,
        signal.actorId,
        'failure',
        { code },
      );
      deps.log.warn({ runId: ref.runId, actorId: signal.actorId, code }, 'gate3 decision refused');
      return { accepted: false, code };
    };

    const facts = await deps.runs.load(ref.tenantId, ref.runId);
    if (facts === null) throw new NotFoundError('Run not found for tenant');
    if (facts.status.state !== 'awaiting_gate3') return refuse('GATE3_RUN_NOT_AWAITING');
    // §8.4 SoD: an unknown requester also fails closed.
    if (facts.requestedBy === null || facts.requestedBy === signal.actorId) {
      return refuse('GATE3_SOD_VIOLATION');
    }
    if (!(await deps.permissions.canRelease(ref.tenantId, signal.actorId))) {
      return refuse('GATE3_NOT_PERMITTED');
    }

    const { unique, conflicts } = dedupeDecisions(signal.decisions);
    const refused: Refusal[] = [...conflicts];
    let released = 0;
    const facts3 = new Map(
      (await deps.findings.list(ref.tenantId, ref.runId)).map((f) => [f.findingId, f.status]),
    );
    for (const d of unique) {
      const status = facts3.get(d.findingId);
      if (status === undefined) {
        refused.push({ findingId: d.findingId, code: 'FINDING_NOT_FOUND' });
      } else if (status === d.decision) {
        continue; // duplicate signal: already applied, idempotent
      } else if (status !== 'confirmed') {
        // Suspected findings never reach Gate 3; a candidate has not been validated yet.
        const decided = status !== 'suspected' && status !== 'candidate' && status !== 'validating';
        refused.push({
          findingId: d.findingId,
          code: decided ? 'DECISION_CONFLICT' : 'FINDING_NOT_CONFIRMED',
        });
      } else if (d.decision === 'accepted_risk' && !acceptedRiskValid(d, now())) {
        refused.push({ findingId: d.findingId, code: 'ACCEPTED_RISK_NEEDS_REASON_AND_EXPIRY' });
      } else {
        const at = now().toISOString();
        const applied = await deps.findings.applyDecision(ref.tenantId, ref.runId, {
          findingId: d.findingId,
          decision: d.decision,
          actorId: signal.actorId,
          at,
          ...(d.reason === undefined ? {} : { reason: d.reason }),
          ...(d.expiresAt === undefined ? {} : { expiresAt: d.expiresAt }),
        });
        if (!applied) {
          refused.push({ findingId: d.findingId, code: 'DECISION_CONFLICT' });
          continue;
        }
        deps.metrics.gate3Decision(d.decision);
        await audit('gate3.decided', ref, d.findingId, signal.actorId, 'success', {
          findingId: d.findingId,
          decision: d.decision,
          ...(d.reason === undefined ? {} : { reason: d.reason }),
          ...(d.expiresAt === undefined ? {} : { expiresAt: d.expiresAt }),
        });
        if (d.decision === 'released') {
          deps.metrics.released();
          released++;
          await audit('finding.released', ref, d.findingId, signal.actorId, 'success', {
            findingId: d.findingId,
            releasedAt: at,
          });
        }
      }
    }

    const allDecided = (await confirmedPending(ref)) === 0;
    if (allDecided) {
      await transition(ref, { type: 'gate3_released' }, 'released', actor);
    }
    return { accepted: true, allDecided, released, refused };
  }
}

function toRecord(
  outcome: CandidateOutcome,
): Parameters<PostExecutionFindingRepo['recordOutcome']>[2] {
  return outcome.outcome === 'confirmed'
    ? {
        findingId: outcome.findingId,
        status: 'confirmed',
        evidenceBundleId: outcome.evidenceBundleId,
        reproArtifactId: outcome.reproArtifactId,
      }
    : { findingId: outcome.findingId, status: 'suspected', suspectedReason: outcome.reason };
}
