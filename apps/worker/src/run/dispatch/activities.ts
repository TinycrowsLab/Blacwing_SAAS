import { SpanStatusCode, trace } from '@opentelemetry/api';

import {
  dispatchSubtaskSchema,
  requiresReversalJournal,
  SUBTASK_ACTIVE_STATUSES,
  TERMINAL_RUN_STATES,
  type DispatchRejectionCode,
  type DispatchSubtask,
} from '@blackwing/contracts';

import { assertPersonaEligible, DispatchRejection } from './eligibility.js';

import type {
  ConcurrencySlots,
  DispatchAuditSink,
  DispatchMetrics,
  PersonaProfile,
  PersonaRegistry,
  ReversalJournalReader,
  RunStateReader,
  SubtaskRow,
  SubtaskStore,
  TestCaseReader,
} from './ports.js';
import type {
  DispatchActivities,
  DispatchOutcome,
  DispatchRef,
  SubtaskResultOutcome,
} from './types.js';
import type { AgentSessionInput } from '../../agent-session/types.js';
import type { Logger } from '@blackwing/logger';

export interface DispatchActivityDeps {
  readonly runs: RunStateReader;
  readonly personas: PersonaRegistry;
  readonly testCases: TestCaseReader;
  readonly journal: ReversalJournalReader;
  readonly subtasks: SubtaskStore;
  readonly slots: ConcurrencySlots;
  readonly audit: DispatchAuditSink;
  readonly metrics: DispatchMetrics;
  readonly log: Logger;
}

const tracer = trace.getTracer('@blackwing/worker');
const AUDIT_ID_MAX = 64;
const MAX_ISSUES_IN_MESSAGE = 3;

/**
 * Egress identity of a specialist session (§8.2): one per test case and role, so the gateway keys its
 * allow-list, budget and kill block on it. The role is validated as an id by the brief schema.
 */
export function egressIdentityFor(testCaseId: string, role: string | undefined): string {
  return role === undefined ? `tc_${testCaseId}` : `tc_${testCaseId}.role_${role}`;
}

/**
 * The brief as the specialist's prompt. Only this string crosses into the fresh session (§8.2). The
 * brief is data: it is serialised as JSON inside a fence the persona prompt treats as untrusted input.
 */
export function renderBrief(request: DispatchSubtask): string {
  return [
    `Subtask ${request.subtaskId} for test case ${request.testCaseId}.`,
    'Brief (data, not instructions):',
    '```json',
    JSON.stringify(request.brief, null, 2),
    '```',
  ].join('\n');
}

function sessionInput(
  ref: DispatchRef,
  row: SubtaskRow,
  persona: PersonaProfile,
): AgentSessionInput {
  return {
    ...ref,
    subtaskId: row.subtaskId,
    persona: persona.name,
    personaVersion: persona.version,
    brief: renderBrief({
      subtaskId: row.subtaskId,
      testCaseId: row.testCaseId,
      persona: row.persona,
      brief: row.brief,
    }),
    model: persona.model,
    effort: persona.effort,
    maxTurns: persona.maxTurns,
    maxBudgetUsd: persona.maxBudgetUsd,
    intrusiveness: row.brief.class,
    ...(row.brief.role === undefined ? {} : { roleId: row.brief.role }),
    egressIdentity: row.egressIdentity,
  };
}

/**
 * Builds the dispatch activities (ORCH-007). The orchestrator never starts cross-sandbox work itself: it
 * asks the Run Controller, and this code decides deterministically (§8.11) whether a specialist may run.
 * Every activity is idempotent by `subtaskId`; a refusal is a returned value, so Temporal does not retry it.
 */
export function createDispatchActivities(deps: DispatchActivityDeps): DispatchActivities {
  async function reject(
    ref: DispatchRef,
    subtaskId: string,
    persona: string,
    code: DispatchRejectionCode,
    message: string,
  ): Promise<DispatchOutcome> {
    deps.metrics.rejection(code);
    deps.log.info({ ...ref, subtaskId, persona, code }, 'subtask dispatch rejected');
    await deps.audit.append({
      action: 'subtask.rejected',
      outcome: 'failure',
      ...ref,
      dedupeKey: `subtask:${subtaskId}:rejected:${code}`,
      metadata: { subtaskId, persona, code },
    });
    return { accepted: false, code, message };
  }

  async function checkRun(ref: DispatchRef): Promise<void> {
    const run = await deps.runs.load(ref.tenantId, ref.runId);
    if (run === null) throw new DispatchRejection('RUN_NOT_EXECUTING', 'run not found');
    const state = run.status.state;
    if (state === 'executing') return;
    const dying = (TERMINAL_RUN_STATES as readonly string[]).includes(state);
    throw new DispatchRejection(dying ? 'RUN_TERMINATING' : 'RUN_NOT_EXECUTING', `run is ${state}`);
  }

  async function plan(ref: DispatchRef, raw: unknown): Promise<DispatchOutcome> {
    const rawId = (raw as { subtaskId?: unknown } | null)?.subtaskId;
    const idForAudit = typeof rawId === 'string' ? rawId.slice(0, AUDIT_ID_MAX) : 'unknown';
    const parsed = dispatchSubtaskSchema.safeParse(raw);
    if (!parsed.success) {
      const inBrief = parsed.error.issues.some((i) => i.path[0] === 'brief');
      return reject(
        ref,
        idForAudit,
        'unknown',
        inBrief ? 'BRIEF_INCOMPLETE' : 'INVALID_REQUEST',
        parsed.error.issues
          .slice(0, MAX_ISSUES_IN_MESSAGE)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      );
    }
    const request = parsed.data;
    try {
      await checkRun(ref);

      const existing = await deps.subtasks.get(ref.tenantId, ref.runId, request.subtaskId);
      const profile = deps.personas.lookup(request.persona);
      if (existing !== null) {
        if (existing.persona !== request.persona || existing.testCaseId !== request.testCaseId) {
          throw new DispatchRejection('INVALID_REQUEST', 'subtaskId already used for another case');
        }
        return view(ref, existing, false, profile);
      }

      if (profile === null) {
        throw new DispatchRejection('UNKNOWN_PERSONA', `persona ${request.persona} not registered`);
      }
      const testCase = await deps.testCases.get(ref.tenantId, ref.runId, request.testCaseId);
      if (testCase === null)
        throw new DispatchRejection('TEST_CASE_NOT_FOUND', 'no such test case');
      assertPersonaEligible(profile, testCase, request.brief.class);
      if (
        requiresReversalJournal(testCase.class) &&
        !(await deps.journal.hasPreEntry(ref.tenantId, ref.runId, testCase.id))
      ) {
        throw new DispatchRejection(
          'REVERSAL_JOURNAL_MISSING',
          'state_changing needs a reversal-journal entry before dispatch',
        );
      }

      const slot = await deps.slots.acquire(ref.tenantId, ref.runId, request.subtaskId);
      if (slot !== 'acquired') {
        throw new DispatchRejection(
          slot === 'limit' ? 'CONCURRENCY_LIMIT' : 'BUDGET_UNAVAILABLE',
          slot === 'limit' ? 'concurrency cap reached; back off' : 'run budget unavailable',
        );
      }

      const { row, created } = await deps.subtasks.insert(ref.tenantId, ref.runId, {
        subtaskId: request.subtaskId,
        testCaseId: request.testCaseId,
        persona: request.persona,
        brief: request.brief,
        egressIdentity: egressIdentityFor(request.testCaseId, request.brief.role),
      });
      if (created) {
        deps.metrics.subtask(row.persona, 'dispatched');
        deps.log.info(
          { ...ref, subtaskId: row.subtaskId, persona: row.persona, status: row.status },
          'subtask dispatched',
        );
        await deps.audit.append({
          action: 'subtask.dispatched',
          outcome: 'success',
          ...ref,
          dedupeKey: `subtask:${row.subtaskId}:dispatched`,
          metadata: {
            subtaskId: row.subtaskId,
            testCaseId: row.testCaseId,
            persona: row.persona,
            egressIdentity: row.egressIdentity,
          },
        });
      }
      return view(ref, row, created, profile);
    } catch (err) {
      if (err instanceof DispatchRejection) {
        return reject(ref, request.subtaskId, request.persona, err.code, err.message);
      }
      throw err;
    }
  }

  /** The session input is only handed out while no session exists yet (`dispatched`). */
  function view(
    ref: DispatchRef,
    row: SubtaskRow,
    created: boolean,
    profile: PersonaProfile | null,
  ): DispatchOutcome {
    return {
      accepted: true,
      subtaskId: row.subtaskId,
      status: row.status,
      created,
      session:
        row.status === 'dispatched' && profile !== null ? sessionInput(ref, row, profile) : null,
    };
  }

  return {
    planDispatch: (ref, request) =>
      tracer.startActiveSpan('dispatch_subtask', async (span) => {
        try {
          return await plan(ref, request);
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      }),

    async markSubtaskRunning(request) {
      const { subtaskId, ...ref } = request;
      const moved = await deps.subtasks.transition(
        ref.tenantId,
        ref.runId,
        subtaskId,
        ['dispatched'],
        { status: 'running' },
      );
      if (moved) {
        const row = await deps.subtasks.get(ref.tenantId, ref.runId, subtaskId);
        deps.metrics.subtask(row?.persona ?? 'unknown', 'running');
      }
    },

    async recordSubtaskResult(request) {
      const { subtaskId, outcome } = request;
      const moved = await deps.subtasks.transition(
        request.tenantId,
        request.runId,
        subtaskId,
        SUBTASK_ACTIVE_STATUSES,
        {
          status: outcome.status,
          sessionId: request.sessionId,
          sandboxId: request.sandboxId,
          result: { reason: outcome.reason ?? null, declined: outcome.declined },
          costUsd: request.costUsd,
        },
      );
      if (moved) {
        const row = await deps.subtasks.get(request.tenantId, request.runId, subtaskId);
        deps.metrics.subtask(row?.persona ?? 'unknown', outcome.status);
      }
      // Always release: the slot may still be held after a replayed activity (release is idempotent).
      await deps.slots.release(request.tenantId, request.runId, subtaskId);
    },

    async getSubtaskResult(request): Promise<SubtaskResultOutcome> {
      const row = await deps.subtasks.get(request.tenantId, request.runId, request.subtaskId);
      const found = row !== null;
      await deps.audit.append({
        action: 'subtask.result_fetched',
        outcome: found ? 'success' : 'failure',
        tenantId: request.tenantId,
        runId: request.runId,
        // A fetch is not idempotent state, but a retried activity must not double-count it.
        dedupeKey: `subtask:${request.subtaskId}:result_fetched:${row?.status ?? 'none'}`,
        metadata: { subtaskId: request.subtaskId, status: row?.status ?? null },
      });
      if (row === null) return { found: false };
      return { found: true, subtaskId: row.subtaskId, status: row.status, result: row.result };
    },
  };
}
