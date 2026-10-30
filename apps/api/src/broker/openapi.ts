import { z } from 'zod';

import {
  BROKER_BASE_PATH,
  brokerCandidateRequestSchema,
  brokerEvidenceRequestSchema,
  brokerGate2ExceptionRequestSchema,
  brokerGate2ExceptionResponseSchema,
  brokerJournalRequestSchema,
  brokerPdpDecisionSchema,
  brokerPdpEvaluateRequestSchema,
  brokerStateResponseSchema,
  gate2IdempotencyKeySchema,
  brokerToolAuditRequestSchema,
  engagementDispatchInputSchema,
  engagementDispatchResultSchema,
  engagementMarkTestCaseInputSchema,
  engagementMarkTestCaseResultSchema,
  engagementMentorReviewInputSchema,
  engagementMentorReviewResultSchema,
  engagementOpenSubtasksSchema,
  engagementScopeExceptionInputSchema,
  engagementScopeExceptionResultSchema,
  engagementStateSchema,
  engagementSubtaskResultSchema,
} from '@blackwing/contracts';
import { ERROR_CODES, PROBLEM_JSON_CONTENT_TYPE } from '@blackwing/errors';

import {
  BROKER_CANDIDATES_ROUTE,
  BROKER_GATE2_EXCEPTIONS_ROUTE,
  BROKER_ENGAGEMENT_DISPATCH_ROUTE,
  BROKER_ENGAGEMENT_MENTOR_REVIEW_ROUTE,
  BROKER_ENGAGEMENT_OPEN_SUBTASKS_ROUTE,
  BROKER_ENGAGEMENT_SCOPE_EXCEPTION_ROUTE,
  BROKER_ENGAGEMENT_STATE_ROUTE,
  BROKER_ENGAGEMENT_SUBTASK_RESULT_ROUTE,
  BROKER_ENGAGEMENT_TEST_CASE_STATUS_ROUTE,
  BROKER_EVIDENCE_ROUTE,
  BROKER_JOURNAL_ROUTE,
  BROKER_PDP_EVALUATE_ROUTE,
  BROKER_STATE_ROUTE,
  BROKER_TOOL_AUDIT_ROUTE,
} from './routes.js';

type JsonObject = Record<string, unknown>;

const jsonSchema = (schema: z.ZodType): JsonObject => {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'input',
  }) as JsonObject;
  const rest = { ...generated };
  delete rest.$schema;
  return rest;
};

/** Error codes every broker endpoint can answer with. */
const COMMON_CODES = ['UNAUTHENTICATED', 'FORBIDDEN', 'RATE_LIMITED', 'NOT_IMPLEMENTED'] as const;

const toOpenApiPath = (route: string): string => route.replaceAll(/:(\w+)/g, '{$1}');

function responses(extra: readonly (keyof typeof ERROR_CODES)[]): JsonObject {
  const codes = [...COMMON_CODES, ...extra];
  const byStatus = new Map<number, string[]>();
  for (const code of codes) {
    const status = ERROR_CODES[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()].map(([status, list]) => [
      String(status),
      {
        description: `Problem details; code is one of ${list.join(', ')}.`,
        content: {
          [PROBLEM_JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/Problem' } },
        },
      },
    ]),
  );
}

const runIdParameter = {
  name: 'runId',
  in: 'path',
  required: true,
  description: 'Must equal the run id inside the bwrun_ token, otherwise 403.',
  schema: { type: 'string', format: 'uuid' },
};

/** An engagement endpoint: answers 200 when its adapter is wired, otherwise 501 (MCP-012). */
function engagementOperation(
  method: 'get' | 'post',
  operationId: string,
  summary: string,
  owner: string,
  responseSchema: z.ZodType,
  requestSchema?: z.ZodType,
  extraParams: readonly JsonObject[] = [],
): JsonObject {
  return {
    [method]: {
      operationId,
      summary,
      description: `Owned by ${owner}; answers 501 until its adapter is wired.`,
      security: [{ runToken: [] }],
      parameters: [runIdParameter, ...extraParams],
      ...(requestSchema === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(requestSchema) } },
            },
          }),
      responses: {
        ...responses(
          requestSchema === undefined
            ? ['NOT_FOUND']
            : ['VALIDATION_FAILED', 'RUN_NOT_ACTIVE', 'INVALID_TRANSITION'],
        ),
        '200': {
          description: 'Result of the engagement call.',
          content: { 'application/json': { schema: jsonSchema(responseSchema) } },
        },
      },
    },
  };
}

function writeOperation(
  operationId: string,
  summary: string,
  owner: string,
  schema: z.ZodType,
): JsonObject {
  return {
    post: {
      operationId,
      summary,
      description: `Stub owned by ${owner}: validates the request and answers 501 until implemented.`,
      security: [{ runToken: [] }],
      parameters: [runIdParameter],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: jsonSchema(schema) } },
      },
      responses: responses(['VALIDATION_FAILED', 'RUN_NOT_ACTIVE']),
    },
  };
}

/**
 * OpenAPI 3.1 document of the INTERNAL Run Broker API. It is published to the broker's consumers (tool
 * backends in the sandbox network) only; it is never merged into the public document, whose paths all
 * live under `/v1` (API-014 acceptance: `/internal/broker/*` is absent from the public spec).
 */
export function brokerOpenApiDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Blackwing internal Run Broker API',
      version: '1.0.0',
      description:
        'Reachable only from the sandbox run network with a short-lived run-scoped token (CONTEXT_PACK §4.1, §9). Internal: not part of the public API.',
    },
    paths: {
      [toOpenApiPath(BROKER_CANDIDATES_ROUTE)]: writeOperation(
        'submitCandidate',
        'Submit a finding candidate',
        'FINDING/VALIDATE',
        brokerCandidateRequestSchema,
      ),
      [toOpenApiPath(BROKER_EVIDENCE_ROUTE)]: writeOperation(
        'recordEvidence',
        'Record evidence metadata',
        'EVIDENCE',
        brokerEvidenceRequestSchema,
      ),
      [toOpenApiPath(BROKER_JOURNAL_ROUTE)]: writeOperation(
        'appendJournal',
        'Append a reversal-journal entry',
        'REVERSAL',
        brokerJournalRequestSchema,
      ),
      [toOpenApiPath(BROKER_PDP_EVALUATE_ROUTE)]: {
        post: {
          operationId: 'evaluatePdp',
          summary: 'Decide one PreToolUse tool call (allow, deny or exception)',
          description:
            'Evaluates a tool call against the run envelope, scope and journal facts the broker loads. `exception` is an out-of-envelope call a human may approve through Gate 2 (the runtime then opens that exception). Answers 501 until the PDP is wired; the runtime then denies (fail closed).',
          security: [{ runToken: [] }],
          parameters: [runIdParameter],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: jsonSchema(brokerPdpEvaluateRequestSchema) },
            },
          },
          responses: {
            ...responses(['VALIDATION_FAILED', 'RUN_NOT_ACTIVE']),
            '200': {
              description: 'The decision and its stable reason.',
              content: { 'application/json': { schema: jsonSchema(brokerPdpDecisionSchema) } },
            },
          },
        },
      },
      [toOpenApiPath(BROKER_TOOL_AUDIT_ROUTE)]: writeOperation(
        'recordToolInvocation',
        'Record a tool.invoked audit event',
        'AUDIT',
        brokerToolAuditRequestSchema,
      ),
      [toOpenApiPath(BROKER_ENGAGEMENT_STATE_ROUTE)]: engagementOperation(
        'get',
        'getEngagementState',
        'Read the engagement state',
        'ORCH/WORKFLOW',
        engagementStateSchema,
      ),
      [toOpenApiPath(BROKER_ENGAGEMENT_OPEN_SUBTASKS_ROUTE)]: engagementOperation(
        'get',
        'listOpenSubtasks',
        'List approved test cases without a subtask',
        'ORCH',
        engagementOpenSubtasksSchema,
      ),
      [toOpenApiPath(BROKER_ENGAGEMENT_DISPATCH_ROUTE)]: engagementOperation(
        'post',
        'dispatchSubtask',
        'Dispatch a specialist through the Run Controller',
        'ORCH/WORKFLOW',
        engagementDispatchResultSchema,
        engagementDispatchInputSchema,
      ),
      [toOpenApiPath(BROKER_ENGAGEMENT_SUBTASK_RESULT_ROUTE)]: engagementOperation(
        'get',
        'getSubtaskResult',
        'Read a subtask result (pending while in flight)',
        'ORCH',
        engagementSubtaskResultSchema,
        undefined,
        [
          {
            name: 'subtaskId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
      ),
      [toOpenApiPath(BROKER_ENGAGEMENT_TEST_CASE_STATUS_ROUTE)]: engagementOperation(
        'post',
        'markTestCaseStatus',
        'Move a test case to an allowed execution status',
        'ORCH',
        engagementMarkTestCaseResultSchema,
        engagementMarkTestCaseInputSchema,
      ),
      [toOpenApiPath(BROKER_ENGAGEMENT_MENTOR_REVIEW_ROUTE)]: engagementOperation(
        'post',
        'requestMentorReview',
        'Raise a mentor review for a stalled subtask',
        'MENTOR',
        engagementMentorReviewResultSchema,
        engagementMentorReviewInputSchema,
      ),
      [toOpenApiPath(BROKER_ENGAGEMENT_SCOPE_EXCEPTION_ROUTE)]: engagementOperation(
        'post',
        'requestScopeException',
        'Open a Gate 2 scope exception',
        'GATE2',
        engagementScopeExceptionResultSchema,
        engagementScopeExceptionInputSchema,
      ),
      [toOpenApiPath(BROKER_GATE2_EXCEPTIONS_ROUTE)]: {
        post: {
          operationId: 'raiseGate2Exception',
          summary: 'Open a Gate 2 exception for a deferred tool call',
          description:
            'Owned by GATE2. Creates one pending exception (idempotent on Idempotency-Key), pauses the run as gate2_pending and signals the run workflow. A failed signal answers 503 after the exception is stored, so the caller retries with the same key.',
          security: [{ runToken: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: jsonSchema(gate2IdempotencyKeySchema),
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: jsonSchema(brokerGate2ExceptionRequestSchema) },
            },
          },
          responses: {
            ...responses([
              'VALIDATION_FAILED',
              'RUN_NOT_ACTIVE',
              'IDEMPOTENCY_KEY_REQUIRED',
              'TEMPORAL_UNAVAILABLE',
            ]),
            '200': {
              description: 'The exception and its state.',
              content: {
                'application/json': { schema: jsonSchema(brokerGate2ExceptionResponseSchema) },
              },
            },
          },
        },
      },
      [toOpenApiPath(BROKER_STATE_ROUTE)]: {
        get: {
          operationId: 'getRunState',
          summary: 'Read the run state',
          description: `Stub owned by ORCH/WORKFLOW; answers 501 until implemented. The eventual 200 body is ${BROKER_BASE_PATH}-internal.`,
          security: [{ runToken: [] }],
          parameters: [runIdParameter],
          responses: {
            ...responses([]),
            '200': {
              description: 'Reserved contract for the implemented endpoint.',
              content: { 'application/json': { schema: jsonSchema(brokerStateResponseSchema) } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        runToken: { type: 'http', scheme: 'bearer', description: 'bwrun_<payload>.<signature>' },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'code', 'traceId'],
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string' },
            traceId: { type: 'string' },
          },
        },
      },
    },
  };
}
