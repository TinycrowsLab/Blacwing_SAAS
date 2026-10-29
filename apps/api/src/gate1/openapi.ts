import {
  gate1DecisionRequestSchema,
  gate1DecisionResponseSchema,
  gate1PlanViewSchema,
} from '@blackwing/contracts';

import { errorResponses, jsonSchema, type JsonObject } from '../openapi/schema.js';

/** Error codes the Gate 1 routes answer with (the registry codes they can raise). */
const GATE1_PLAN_ERRORS = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'TENANT_CONTEXT_MISSING',
  'RATE_LIMITED',
] as const;
const GATE1_DECISION_ERRORS = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SOD_VIOLATION',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_MISMATCH',
  'GATE1_NOT_PENDING',
  'GATE1_PLAN_STALE',
  'GATE1_EXPIRED',
  'TENANT_CONTEXT_MISSING',
  'RATE_LIMITED',
] as const;

/**
 * The Gate 1 (test plan approval) API as a module of the public document (#877). The decision operation
 * documents the server-side separation of duties: a requester who posts it gets 403 `SOD_VIOLATION`.
 */
export function gate1OpenApiModule(): {
  readonly tag: string;
  readonly description: string;
  readonly paths: JsonObject;
  readonly schemas: JsonObject;
} {
  const budget = { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 100 };
  const planExample = {
    runId: 'run_01jbz3k6w8f5r4t2n9q7x0m1ab',
    runState: 'awaiting_gate1',
    planVersion: 3,
    requesterId: 'user-requester',
    requestedAt: '2026-10-29T08:00:00.000Z',
    expiresAt: '2026-10-29T12:00:00.000Z',
    testCases: [
      {
        id: 'tc-1',
        title: 'Security headers reviewed',
        class: 'passive',
        targets: ['https://lab.example.test/'],
        budget,
      },
    ],
    budgetTotals: { maxRequests: 10, maxBytes: 100 },
    changes: null,
    viewer: { canDecide: true, isRequester: false },
  };
  const runIdParameter = {
    name: 'runId',
    in: 'path',
    required: true,
    schema: { type: 'string', pattern: '^run_[0-9A-Za-z]{4,64}$' },
    example: 'run_01jbz3k6w8f5r4t2n9q7x0m1ab',
  };
  return {
    tag: 'gate1',
    description:
      'Gate 1: approval of the test plan before any test runs (separation of duties, §8.4).',
    schemas: {
      Gate1PlanView: jsonSchema(gate1PlanViewSchema),
      Gate1DecisionRequest: jsonSchema(gate1DecisionRequestSchema),
      Gate1DecisionResponse: jsonSchema(gate1DecisionResponseSchema),
    },
    paths: {
      '/v1/runs/{runId}/gate1': {
        get: {
          operationId: 'getGate1Plan',
          summary: 'Read the test plan under Gate 1 review',
          description:
            'Requires testplan:read. `viewer.canDecide` is a UX hint: false for the requester, for a caller without testplan:approve, and for a run not awaiting Gate 1.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [runIdParameter],
          responses: {
            '200': {
              description: 'The plan and what the caller may do with it.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Gate1PlanView' },
                  example: planExample,
                },
              },
            },
            ...errorResponses(GATE1_PLAN_ERRORS),
          },
        },
      },
      '/v1/runs/{runId}/gate1/decisions': {
        post: {
          operationId: 'decideGate1',
          summary: 'Approve, request changes to, or reject a test plan',
          description:
            'Requires testplan:approve and an Idempotency-Key. The requester may not decide their own plan (403 SOD_VIOLATION). `planVersion` must be the version reviewed (409 GATE1_PLAN_STALE otherwise). A replay with the same key and body answers the first result.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            runIdParameter,
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description: 'Unique per decision attempt; reuse it only to retry the same decision.',
              schema: { type: 'string', minLength: 8, maxLength: 2048 },
              example: 'gate1-7f3c2a9e-1',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Gate1DecisionRequest' },
                example: {
                  decision: 'request_changes',
                  planVersion: 3,
                  reason: 'Drop the admin panel from scope.',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The decision and the run state it produced.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Gate1DecisionResponse' },
                  example: {
                    runId: 'run_01jbz3k6w8f5r4t2n9q7x0m1ab',
                    decision: 'approve',
                    planVersion: 3,
                    runState: 'approved',
                    decidedAt: '2026-10-29T10:00:00.000Z',
                  },
                },
              },
            },
            ...errorResponses(GATE1_DECISION_ERRORS),
          },
        },
      },
    },
  };
}
