import { createHash } from 'node:crypto';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  brokerCandidateResponseSchema,
  cweIdSchema,
  findingLocationSchema,
  type IntrusivenessClass,
  LIMITS,
  type Oracle,
  oracleSchema,
  requiresReversalJournal,
  type TestCaseStatus,
  uuidV7Schema,
} from '@blackwing/contracts';

import { type ToolResult, toolFailure } from '../errors.js';
import { defineTool, type ToolDefinition } from '../tool.js';

import type { CandidateMetrics } from './metrics.js';

/** Longest summary kept on a candidate; the evidence holds the detail. */
const CANDIDATE_SUMMARY_MAX = 2000;
const EVIDENCE_REFS_MAX = 50;
const WSTG_REFS_MAX = 20;

/** Why a submission was refused (`mcp_candidate_rejections_total{reason}`). */
type CandidateRejectionReason =
  | 'wrong_test_case'
  | 'test_case_not_running'
  | 'oracle_not_predeclared'
  | 'missing_negative_control'
  | 'missing_reversal_journal'
  | 'invalid_evidence';

/** The persisted test-case record the session runs, read before the test ran (§7). */
export interface DeclaredTestCase {
  readonly id: string;
  /** Intrusiveness class (§3.5), not the vulnerability class. */
  readonly class: IntrusivenessClass;
  readonly status: TestCaseStatus;
  readonly oracle: Oracle;
  readonly negativeControl: Oracle | null;
}

/** Everything the session fixes for `submit_candidate`; none of it is model input. */
export interface SubmitCandidateSession {
  readonly testCase: DeclaredTestCase;
  /** True when every id is evidence of this run. */
  evidenceExists(ids: readonly string[]): Promise<boolean>;
  /** True when the reversal journal holds an entry for this test case (§8.3). */
  hasReversalEntry(testCaseId: string): Promise<boolean>;
  readonly metrics: CandidateMetrics;
}

// No `status` field and no tenant/run ids: the model cannot name them (§8.11); the strict object rejects extras.
export const submitCandidateInputSchema = z.strictObject({
  testCaseId: uuidV7Schema,
  class: z.string().min(1).max(LIMITS.shortTextMax),
  cweId: cweIdSchema,
  owaspCategory: z.string().min(1).max(LIMITS.shortTextMax),
  /** WSTG ids the test case cites. Recorded in the tool audit; the broker body does not carry them. */
  wstgRefs: z.array(z.string().min(1).max(LIMITS.keyMax)).max(WSTG_REFS_MAX).default([]),
  location: findingLocationSchema.refine(
    (location) => location.urlTemplate !== null || location.file !== null,
    'a location needs a URL template or a file',
  ),
  oracleBinding: oracleSchema,
  negativeControlRef: z.string().min(1).max(LIMITS.keyMax),
  evidenceRefs: z.array(uuidV7Schema).min(1).max(EVIDENCE_REFS_MAX),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
});
export type SubmitCandidateInput = z.infer<typeof submitCandidateInputSchema>;

export const submitCandidateOutputSchema = z.strictObject({
  findingId: uuidV7Schema,
  status: z.literal('candidate'),
});

const RUNNING: readonly TestCaseStatus[] = ['approved', 'executing', 'executed'];

/** JSON with sorted object keys, so equal values always serialise equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The idempotency key: `(testCaseId, location, oracleBinding)`. */
function candidateKey(
  input: Pick<SubmitCandidateInput, 'testCaseId' | 'location' | 'oracleBinding'>,
): string {
  return createHash('sha256')
    .update(canonical([input.testCaseId, input.location, input.oracleBinding]))
    .digest('hex');
}

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * `mcp__findings__submit_candidate` (MCP-009): a specialist submits a candidate bound to the pre-declared
 * oracle and negative control of its test case. The tool only ever creates a `candidate`; confirming is the
 * deterministic Validator's job (§8.11).
 */
export function createSubmitCandidateTool(session: SubmitCandidateSession): ToolDefinition {
  const tracer = trace.getTracer('blackwing.mcp-tools');
  const submitted = new Map<string, Promise<z.infer<typeof submitCandidateOutputSchema>>>();

  const reject = (reason: CandidateRejectionReason): ToolResult<never> => {
    session.metrics.rejections.inc({ reason });
    return toolFailure('TOOL_INVALID_INPUT', `Rejected: ${reason}`);
  };

  return defineTool({
    server: 'findings',
    name: 'submit_candidate',
    description:
      'Submit a candidate finding for validation. It must cite your test case, the oracle and negative control ' +
      'that test case declared before it ran, and evidence ids. You never confirm a finding: the Validator ' +
      'replays the oracle. Use standard ids (CWE, OWASP) and no payloads in the summary.',
    inputSchema: submitCandidateInputSchema,
    outputSchema: submitCandidateOutputSchema,
    readOnly: false,
    handler: async (input, context) => {
      const span = tracer.startSpan('mcp.submit_candidate', {
        attributes: { 'blackwing.test_case_id': input.testCaseId },
      });
      try {
        const declared = session.testCase;
        if (input.testCaseId !== declared.id) return reject('wrong_test_case');
        if (declared.class === 'destructive' || !RUNNING.includes(declared.status)) {
          return reject('test_case_not_running');
        }
        // Strict comparison with the stored record: an oracle chosen after the fact cannot match it.
        if (canonical(input.oracleBinding) !== canonical(declared.oracle)) {
          return reject('oracle_not_predeclared');
        }
        if (input.negativeControlRef !== declared.negativeControl?.type) {
          return reject('missing_negative_control');
        }
        if (
          requiresReversalJournal(declared.class) &&
          !(await session.hasReversalEntry(declared.id))
        ) {
          return reject('missing_reversal_journal');
        }
        if (!(await session.evidenceExists(input.evidenceRefs))) return reject('invalid_evidence');

        const key = candidateKey(input);
        let result = submitted.get(key);
        if (result === undefined) {
          result = context.broker
            .post(
              'candidates',
              {
                title: truncate(`${input.class} (${input.cweId})`, LIMITS.labelMax),
                vulnClass: input.class,
                summary: truncate(input.summary, CANDIDATE_SUMMARY_MAX),
                evidenceIds: input.evidenceRefs,
                testCaseId: input.testCaseId,
                cweId: input.cweId,
                owaspCategory: input.owaspCategory,
                location: input.location,
                oracleBinding: input.oracleBinding,
                negativeControlRef: input.negativeControlRef,
                confidence: input.confidence,
                idempotencyKey: key,
              },
              brokerCandidateResponseSchema,
            )
            .then((created) => {
              session.metrics.submitted.inc({ class: input.class });
              return created;
            });
          submitted.set(key, result);
          // A failed submission must stay retryable.
          result.catch(() => submitted.delete(key));
        }
        return { ok: true, data: await result };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  });
}
