import { z } from 'zod';

import {
  modifiedCaseSchema,
  planDiffSchema,
  planFieldChangeSchema,
  planValidationResultSchema,
  testCaseCreateBodySchema,
  testCaseViewSchema,
  testPlanPageSchema,
  testPlanSummarySchema,
} from '@blackwing/contracts';

import {
  errorResponses,
  type JsonObject,
  jsonSchema,
  type OpenApiModule,
} from '../openapi/schema.js';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const ETAG_HEADER: JsonObject = {
  ETag: {
    description: 'Strong validator of this state. Send it back in If-Match to change it.',
    schema: { type: 'string' },
  },
};

const IF_MATCH: JsonObject = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description:
    'The ETag from the last read. A stale value answers 412 ETAG_MISMATCH, a missing one 428.',
  schema: { type: 'string', minLength: 1 },
  example: '"3f9c2a1b8d7e6f50"',
};

const IDEMPOTENCY_KEY: JsonObject = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Makes a retry return the original result instead of a second write (API-008).',
  schema: { type: 'string', minLength: 8, maxLength: 255 },
};

const EXAMPLE_CASE = {
  caseId: '0198f0a0-0000-7000-8000-0000000000c1',
  planId: '0198f0a0-0000-7000-8000-0000000000d1',
  class: 'passive',
  title: 'Login rate limit is enforced',
  status: 'proposed',
  statusReason: null,
  refs: { owasp: ['A07'], wstg: ['WSTG-ATHN-03'], asvs: ['2.2.1'] },
  cweCandidates: ['CWE-307'],
  targets: ['https://app.example.test/login'],
  roles: ['anonymous'],
  budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 1, maxBytes: 1048576 },
  oracle: { type: 'status_code', params: { expected: 429 } },
  negativeControl: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

const EXAMPLE_PLAN = {
  planId: '0198f0a0-0000-7000-8000-0000000000d1',
  runId: '0198f0a0-0000-7000-8000-0000000000e1',
  version: 2,
  status: 'draft',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  cases: [EXAMPLE_CASE],
};

/**
 * A declared check as the document describes it: a type key and a free JSON object of parameters. The contract
 * types `params` with `z.json()`, which the document generator cannot inline (it leaves a `$defs` reference
 * unresolved), so the document states the same shape with `z.record`. The API still validates the contract.
 */
const oracleDocument = z.looseObject({
  type: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
});

/** The case shapes as documented: the contract schemas with the check fields described by {@link oracleDocument}. */
const caseDocument = testCaseViewSchema.extend({
  oracle: oracleDocument.nullable(),
  negativeControl: oracleDocument.nullable(),
});
const caseCreateDocument = testCaseCreateBodySchema.extend({
  oracle: oracleDocument,
  negativeControl: oracleDocument.nullable(),
});
const casePatchDocument = caseCreateDocument
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field must be provided',
  });
const EXAMPLE_VALIDATION = {
  planId: '0196f5c2-7a1e-7c3a-9b1d-2f4e6a8b0c11',
  runId: '0196f5c2-7a1e-7c3a-9b1d-2f4e6a8b0c10',
  version: 1,
  saId: '0196f5c2-7a1e-7c3a-9b1d-2f4e6a8b0c20',
  ok: true,
  gate1Required: true,
  violations: [],
  budgetTotals: {
    totalRequests: 50,
    totalBytes: 1000000,
    perClassCounts: { passive: 0, active_safe: 1, state_changing: 0, destructive: 0 },
  },
  validatedAt: '2026-10-30T00:00:00.000Z',
};

const planDocument = testPlanSummarySchema.extend({ cases: z.array(caseDocument) });
const pageDocument = testPlanPageSchema.extend({ items: z.array(testPlanSummarySchema) });
/** A field change's before and after are any JSON value; the document leaves them untyped. */
const diffDocument = planDiffSchema.extend({
  modified: z.array(
    modifiedCaseSchema.extend({
      changes: z.array(planFieldChangeSchema.extend({ before: z.unknown(), after: z.unknown() })),
    }),
  ),
});

/** Editable test plans (PLAN-005, CONTEXT_PACK §9): numbered run plan versions and their test cases. */
export function testPlansOpenApiModule(): OpenApiModule {
  const planResponse = (description: string, status = '200'): JsonObject => ({
    [status]: {
      description,
      headers: ETAG_HEADER,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TestPlanView' },
          examples: { plan: { summary: 'A draft version with one case', value: EXAMPLE_PLAN } },
        },
      },
    },
  });
  const caseResponse = (description: string, status = '200'): JsonObject => ({
    [status]: {
      description,
      headers: ETAG_HEADER,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TestCaseView' },
          examples: { case: { summary: 'A proposed case', value: EXAMPLE_CASE } },
        },
      },
    },
  });
  const problem = errorResponses([
    'VALIDATION_FAILED',
    'PLAN_NOT_FOUND',
    'TEST_CASE_NOT_FOUND',
    'PLAN_VERSION_IMMUTABLE',
    'ETAG_MISMATCH',
    'PLAN_PAYLOAD_TOO_LARGE',
    'PRECONDITION_REQUIRED',
    'FORBIDDEN',
    'IDEMPOTENCY_KEY_REQUIRED',
  ]);
  return {
    tag: 'test-plans',
    description:
      'Editable test plans: numbered versions per run, and the cases inside a draft version. An approved version is immutable.',
    paths: {
      '/v1/runs/{runId}/test-plans': {
        post: {
          operationId: 'createTestPlanVersion',
          tags: ['test-plans'],
          summary: 'Create the next version of a run plan',
          description:
            'Copies the non-removed cases of the newest version into a new draft. Requires Idempotency-Key: a retry returns the original version.',
          security: SECURITY,
          parameters: [
            {
              name: 'runId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            IDEMPOTENCY_KEY,
          ],
          responses: { ...planResponse('The new version.', '201'), ...problem },
        },
        get: {
          operationId: 'listTestPlanVersions',
          tags: ['test-plans'],
          summary: 'List the versions of a run plan',
          security: SECURITY,
          parameters: [
            {
              name: 'runId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of versions, oldest first.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TestPlanPage' },
                  examples: {
                    firstPage: {
                      summary: 'The first page, with a cursor for the next',
                      value: {
                        items: [
                          {
                            planId: EXAMPLE_PLAN.planId,
                            runId: EXAMPLE_PLAN.runId,
                            version: 1,
                            status: 'approved',
                            createdAt: '2026-10-01T09:00:00.000Z',
                            updatedAt: '2026-10-01T09:30:00.000Z',
                          },
                        ],
                        nextCursor: 'djoxDQ',
                      },
                    },
                  },
                },
              },
            },
            ...problem,
          },
        },
      },
      '/v1/runs/{runId}/test-plans/{version}': {
        get: {
          operationId: 'getTestPlanVersion',
          tags: ['test-plans'],
          summary: 'Read one plan version with its cases',
          security: SECURITY,
          parameters: [
            {
              name: 'runId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'version',
              in: 'path',
              required: true,
              schema: { type: 'integer', minimum: 1 },
            },
          ],
          responses: { ...planResponse('The version and its cases.'), ...problem },
        },
      },
      '/v1/runs/{runId}/test-plans/{version}/diff': {
        get: {
          operationId: 'diffTestPlanVersions',
          tags: ['test-plans'],
          summary: 'Diff two versions of a run plan',
          description:
            'What changed from `against` to `version`: cases added, removed and modified, with the before and after of each changed field. Cases match by caseId, then by title and targets, so a re-created case is not reported as a removal plus an addition. The answer is deterministic and sorted by caseId, then title.',
          security: SECURITY,
          parameters: [
            {
              name: 'runId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'version',
              in: 'path',
              required: true,
              schema: { type: 'integer', minimum: 1 },
              description: 'The version to diff to.',
            },
            {
              name: 'against',
              in: 'query',
              required: true,
              schema: { type: 'integer', minimum: 1 },
              description: 'The version to diff from. Any earlier or later version of the run.',
            },
          ],
          responses: {
            '200': {
              description: 'The changes from `against` to `version`.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PlanDiff' },
                  examples: {
                    diff: {
                      summary: 'One case re-titled and one added',
                      value: {
                        fromVersion: 1,
                        toVersion: 2,
                        added: [{ caseId: EXAMPLE_CASE.caseId, title: EXAMPLE_CASE.title }],
                        removed: [],
                        modified: [
                          {
                            caseId: EXAMPLE_CASE.caseId,
                            title: 'Login rate limit is enforced',
                            changes: [{ field: 'status', before: 'proposed', after: 'approved' }],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            ...problem,
          },
        },
      },
      '/v1/test-plans/{planId}/cases': {
        post: {
          operationId: 'addTestCase',
          tags: ['test-plans'],
          summary: 'Add a test case to a draft plan version',
          description:
            'Requires If-Match (the plan ETag) and Idempotency-Key. An approved or superseded version answers 409 PLAN_VERSION_IMMUTABLE.',
          security: SECURITY,
          parameters: [
            {
              name: 'planId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            IF_MATCH,
            IDEMPOTENCY_KEY,
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TestCaseCreate' },
                examples: { passive: { summary: 'A passive check', value: EXAMPLE_CASE } },
              },
            },
          },
          responses: { ...caseResponse('The new case and its ETag.', '201'), ...problem },
        },
      },
      '/v1/test-plans/{planId}/validation': {
        get: {
          operationId: 'validateTestPlan',
          tags: ['test-plans'],
          summary: 'Validate a plan version against its standing authorisation',
          description:
            'Checks every case against the run standing authorisation (class ceiling, pre-approved classes, scope, roles, oracle, negative control and budgets), the Cedar plan policy and the run budget. ok is true only when violations is empty. Writes one test_plan.validated audit event.',
          security: SECURITY,
          parameters: [
            {
              name: 'planId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'The validation result, with every violation.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PlanValidationResult' },
                  examples: { valid: { summary: 'A valid plan', value: EXAMPLE_VALIDATION } },
                },
              },
            },
            ...problem,
          },
        },
      },
      '/v1/test-cases/{caseId}': {
        patch: {
          operationId: 'updateTestCase',
          tags: ['test-plans'],
          summary: 'Edit a test case of a draft plan version',
          description: 'Requires If-Match (the case ETag). Only the sent fields change.',
          security: SECURITY,
          parameters: [
            {
              name: 'caseId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            IF_MATCH,
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TestCasePatch' },
                examples: {
                  title: { summary: 'Retitle', value: { title: 'Login rate limit is enforced' } },
                },
              },
            },
          },
          responses: { ...caseResponse('The case after the change.'), ...problem },
        },
        delete: {
          operationId: 'removeTestCase',
          tags: ['test-plans'],
          summary: 'Remove a test case from a draft plan version',
          description:
            'Soft-removes the case (status removed). Removing an already removed case answers 200 and writes nothing. Otherwise requires If-Match.',
          security: SECURITY,
          parameters: [
            {
              name: 'caseId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            { ...IF_MATCH, required: false },
          ],
          responses: { ...caseResponse('The removed case.'), ...problem },
        },
      },
    },
    schemas: {
      TestCaseCreate: jsonSchema(caseCreateDocument),
      TestCasePatch: jsonSchema(casePatchDocument),
      TestCaseView: jsonSchema(caseDocument),
      TestPlanView: jsonSchema(planDocument),
      TestPlanPage: jsonSchema(pageDocument),
      PlanValidationResult: jsonSchema(planValidationResultSchema),
      PlanDiff: jsonSchema(diffDocument),
    },
  };
}
