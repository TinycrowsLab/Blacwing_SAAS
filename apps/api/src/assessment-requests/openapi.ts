import {
  assessmentRequestListResponseSchema,
  assessmentRequestResponseSchema,
  createAssessmentRequestSchema,
  patchAssessmentRequestSchema,
  preflightDryRunResponseSchema,
} from '@blackwing/contracts';

import { type JsonObject, type OpenApiModule, jsonSchema } from '../openapi/schema.js';

const COLLECTION = '/v1/assessment-requests';
const ITEM = `${COLLECTION}/{id}`;

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const ID_PARAMETER: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The `areq_…` public id of the assessment request.',
  schema: { type: 'string', pattern: '^areq_[A-Za-z0-9]+$' },
};

const IF_MATCH_PARAMETER: JsonObject = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description:
    'The ETag of the request being changed (from GET). A stale value answers 412, a missing one 428.',
  schema: { type: 'string', minLength: 1 },
  example: '"v3"',
};

const IDEMPOTENCY_KEY_PARAMETER: JsonObject = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Unique per submit attempt (8 to 255 visible ASCII characters). A replay answers the original response and creates nothing new.',
  schema: { type: 'string', minLength: 8, maxLength: 255 },
};

const EXAMPLE_REQUEST = {
  id: 'areq_01m64cavacexhrddgjb6xd80xv',
  status: 'draft',
  mode: 'grey',
  objective: 'Test the login flow for authentication bypass',
  assetIds: ['0198f0a0-0000-7000-8000-0000000000e1'],
  saId: '0198f0a0-0000-7000-8000-0000000000f1',
  inputManifestId: null,
  scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
  maxIntrusiveness: 'active_safe',
  budgets: { costCapUsd: 5, maxRequests: 5000, maxDurationMs: 3600000 },
  trigger: 'console',
  requestedBy: '0198f0a0-0000-7000-8000-0000000000a1',
  stateVersion: 0,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
};

const ETAG_HEADER: JsonObject = {
  ETag: {
    description:
      'Strong validator of this request state. Send it in If-Match on PATCH and withdraw.',
    schema: { type: 'string' },
  },
};

/** A failure answer: RFC 9457 problem+json, the `Problem` schema every operation shares. */
const problem = (description: string): JsonObject => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const response = (description: string): JsonObject => ({
  description,
  headers: ETAG_HEADER,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/AssessmentRequest' },
      examples: { current: { summary: 'A draft request', value: EXAMPLE_REQUEST } },
    },
  },
});

/** Assessment requests (SCOPE-005): the scoping form's draft, edit, submit and withdraw API. */
export function assessmentRequestOpenApiModule(): OpenApiModule {
  return {
    tag: 'assessment-requests',
    description:
      'Assessment requests: draft, edit, submit (validated against the standing authorisation) and withdraw. Submitting never starts a run.',
    paths: {
      [COLLECTION]: {
        get: {
          operationId: 'listAssessmentRequests',
          tags: ['assessment-requests'],
          summary: 'List the assessment requests of the tenant, newest first',
          security: SECURITY,
          responses: {
            '200': {
              description: 'The requests of the caller tenant.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AssessmentRequestList' },
                  examples: {
                    current: { summary: 'One draft', value: { items: [EXAMPLE_REQUEST] } },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createAssessmentRequest',
          tags: ['assessment-requests'],
          summary: 'Create a draft assessment request',
          description:
            'Needs assessment:create. Every named asset must belong to the tenant (404 otherwise). Nothing is validated against the standing authorisation until submit.',
          security: SECURITY,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AssessmentRequestCreate' },
                examples: {
                  draft: {
                    summary: 'A grey-box draft over one verified asset',
                    value: {
                      mode: 'grey',
                      objective: EXAMPLE_REQUEST.objective,
                      assetIds: EXAMPLE_REQUEST.assetIds,
                      saId: EXAMPLE_REQUEST.saId,
                      scopeRules: EXAMPLE_REQUEST.scopeRules,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': response('The created draft and its ETag.'),
            '422': problem('Body validation failed (validation_failed).'),
          },
        },
      },
      [ITEM]: {
        get: {
          operationId: 'getAssessmentRequest',
          tags: ['assessment-requests'],
          summary: 'Read one assessment request',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          responses: {
            '200': response('The request and its ETag.'),
            '404': problem('Not found in this tenant.'),
          },
        },
        patch: {
          operationId: 'updateAssessmentRequest',
          tags: ['assessment-requests'],
          summary: 'Edit a draft assessment request',
          description:
            'Requires If-Match. Only a draft can be edited (409 otherwise). An empty body is refused.',
          security: SECURITY,
          parameters: [ID_PARAMETER, IF_MATCH_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AssessmentRequestPatch' },
              },
            },
          },
          responses: {
            '200': response('The edited draft and its new ETag.'),
            '412': problem('The ETag is stale.'),
            '428': problem('If-Match is missing.'),
          },
        },
      },
      [`${ITEM}/submit`]: {
        post: {
          operationId: 'submitAssessmentRequest',
          tags: ['assessment-requests'],
          summary: 'Submit a draft after the scope gate',
          description:
            'Runs every check of the gate (asset verification, standing authorisation status, expiry, coverage, intrusiveness ceiling, scope subset, budgets) and answers 422 with all failing checks in errors[] (each with its code and path). A halted tenant answers 409 tenant_halted. Needs Idempotency-Key.',
          security: SECURITY,
          parameters: [ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
          responses: {
            '200': response('The submitted request.'),
            '409': problem(
              'The tenant is halted (tenant_halted), or the request is no longer a draft.',
            ),
            '422': problem('One or more submit checks failed; errors[] lists every failing check.'),
          },
        },
      },
      [`${ITEM}/preflight`]: {
        post: {
          operationId: 'dryRunAssessmentRequestPreflight',
          tags: ['assessment-requests'],
          summary: 'Dry-run the preflight checks of a request before submit',
          description:
            'Read-only feasibility report (#579): the checks that read our own records (authorisation, scope coverage, a DNS lookup of each target host (resolve once, no request to the target), asset verification, the test window, the budgets and the model provider probe). It sends no target traffic, logs in nowhere, notifies nobody and changes no state. A halted tenant answers 409 tenant_halted. Every run is audited.',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          responses: {
            '200': {
              description: 'The dry-run report. ok is false when a blocking check failed.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PreflightDryRun' },
                  examples: {
                    notReady: {
                      summary: 'A verified asset with no open test window',
                      value: {
                        requestId: EXAMPLE_REQUEST.id,
                        dryRun: true,
                        ok: false,
                        results: [
                          {
                            id: 'assertWindowOpen',
                            title: 'Test window is open',
                            severity: 'blocking',
                            status: 'fail',
                            detail: 'no test window of the standing authorisation is open',
                            code: 'WINDOW_CLOSED',
                            remediation:
                              'Schedule the run inside an open test window of the standing authorisation.',
                          },
                        ],
                        blockingFailures: ['assertWindowOpen'],
                      },
                    },
                  },
                },
              },
            },
            '404': problem('Not found in this tenant.'),
            '409': problem('The tenant is halted (tenant_halted).'),
          },
        },
      },
      [`${ITEM}/withdraw`]: {
        post: {
          operationId: 'withdrawAssessmentRequest',
          tags: ['assessment-requests'],
          summary: 'Withdraw a request',
          description: 'Requires If-Match. A withdrawn request is terminal.',
          security: SECURITY,
          parameters: [ID_PARAMETER, IF_MATCH_PARAMETER],
          responses: {
            '200': response('The withdrawn request.'),
            '412': problem('The ETag is stale.'),
            '428': problem('If-Match is missing.'),
          },
        },
      },
    },
    schemas: {
      AssessmentRequest: jsonSchema(assessmentRequestResponseSchema),
      AssessmentRequestList: jsonSchema(assessmentRequestListResponseSchema),
      AssessmentRequestCreate: jsonSchema(createAssessmentRequestSchema),
      AssessmentRequestPatch: jsonSchema(patchAssessmentRequestSchema),
      PreflightDryRun: jsonSchema(preflightDryRunResponseSchema),
    },
  };
}
