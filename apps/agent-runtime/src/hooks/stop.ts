import { z } from 'zod';

import type { PersonaDefinition } from '@blackwing/agents';

/**
 * The `Stop` hook completion contract (CONTEXT_PACK §4.3, #472).
 *
 * A specialist session may end cleanly only if it submitted its subtask deliverable. The check reads
 * the broker's submission state for the session's `subtaskId` (one read) and records the outcome.
 * It never blocks: a missing deliverable is `incomplete`, and the runner maps that to
 * `failed/result_not_submitted` (RUNTIME-013).
 */

/** The deliverables a session can submit for a subtask. Any one of them satisfies the contract. */
const DELIVERABLE_KINDS = ['candidate', 'structured_output', 'no_findings'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

type CompletionResult = 'complete' | 'incomplete' | 'exempt';

/** Broker state port: the deliverable kinds this session has submitted for `subtaskId`. */
export interface DeliverableReader {
  submittedKinds(subtaskId: string): Promise<readonly DeliverableKind[]>;
}

/** One audited completion check (`session.completion_checked`). Ids and the result only. */
export interface CompletionCheckedEvent {
  readonly action: 'session.completion_checked';
  readonly sessionId: string;
  readonly subtaskId: string;
  readonly persona: string;
  readonly result: CompletionResult;
}

interface CompletionAuditSink {
  record(event: CompletionCheckedEvent): void | Promise<void>;
}

interface CompletionMetricsSink {
  /** `agent_incomplete_sessions_total{persona}` */
  incIncompleteSession(persona: string): void;
}

interface CompletionLog {
  info(fields: Readonly<Record<string, string>>, message: string): void;
}

export interface StopCheckPorts {
  readonly deliverables: DeliverableReader;
  readonly audit: CompletionAuditSink;
  readonly metrics: CompletionMetricsSink;
  readonly log: CompletionLog;
}

export interface StopCheckInput {
  /** Only `requiresSubmission` and `name` are read; the rule comes from the persona definition. */
  readonly persona: Pick<PersonaDefinition, 'name' | 'requiresSubmission'>;
  readonly sessionId: string;
  readonly subtaskId: string;
}

export interface StopCheckOutcome {
  readonly completion: CompletionResult;
  /** Set only for `incomplete`; the runner maps it to `failed/result_not_submitted`. */
  readonly failureCode: 'result_not_submitted' | null;
}

/** The broker response is external input, so it is parsed before use (fail closed on any mismatch). */
const submittedKindsSchema = z.array(z.enum(DELIVERABLE_KINDS));

const INCOMPLETE: StopCheckOutcome = {
  completion: 'incomplete',
  failureCode: 'result_not_submitted',
};

/** Decides the outcome. Broker failures and malformed responses count as incomplete, never complete. */
async function decide(
  input: StopCheckInput,
  deliverables: DeliverableReader,
): Promise<StopCheckOutcome> {
  if (!input.persona.requiresSubmission) {
    return { completion: 'exempt', failureCode: null };
  }
  let kinds: readonly DeliverableKind[];
  try {
    kinds = submittedKindsSchema.parse(await deliverables.submittedKinds(input.subtaskId));
  } catch {
    return INCOMPLETE;
  }
  return kinds.length > 0 ? { completion: 'complete', failureCode: null } : INCOMPLETE;
}

/**
 * Runs the completion check for one session stop. Audit failures reject, so a stop cannot finish
 * without its completion record.
 */
export async function checkCompletion(
  input: StopCheckInput,
  ports: StopCheckPorts,
): Promise<StopCheckOutcome> {
  const outcome = await decide(input, ports.deliverables);
  const persona = input.persona.name;

  await ports.audit.record({
    action: 'session.completion_checked',
    sessionId: input.sessionId,
    subtaskId: input.subtaskId,
    persona,
    result: outcome.completion,
  });
  if (outcome.completion === 'incomplete') {
    ports.metrics.incIncompleteSession(persona);
  }
  ports.log.info(
    {
      subtaskId: input.subtaskId,
      sessionId: input.sessionId,
      persona,
      completion: outcome.completion,
    },
    'session.completion_checked',
  );
  return outcome;
}
