import {
  createStandingAuthorisationSchema,
  idempotencyKeySchema,
  patchStandingAuthorisationSchema,
  standingAuthorisationDtoSchema,
} from '@blackwing/contracts';

import {
  errorResponses,
  type JsonObject,
  jsonSchema,
  type OpenApiModule,
  registerSchema,
} from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

const BASE = '/v1/standing-authorisations';
const ITEM = `${BASE}/{id}`;
const SUBMIT = `${BASE}/{id}/submit`;

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const ETAG_HEADER: JsonObject = {
  ETag: {
    description: 'Strong validator of this version. Send it in If-Match on PATCH and submit.',
    schema: { type: 'string' },
  },
};

const IDEMPOTENCY_KEY_PARAM: JsonObject = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Replays of the same key return the first response; reuse with another body is refused.',
  schema: jsonSchema(idempotencyKeySchema),
  example: 'sa-draft-2026-10-29-1',
};

const IF_MATCH_PARAM: JsonObject = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description:
    'The ETag of the version being changed (from the last read or change). A stale value answers 412, a missing one 428.',
  schema: { type: 'string', minLength: 1 },
  example: '"v1"',
};

const ID_PARAM: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The standing authorisation public id (sa_…).',
  schema: { type: 'string', minLength: 1 },
  example: 'sa_0198f0a0000070008000000000000001',
};

const EXAMPLE_SA = {
  id: 'sa_0198f0a0000070008000000000000001',
  assetIds: ['0198f0a0-0000-7000-8000-0000000000a1'],
  scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
  maxIntrusiveness: 'active_safe',
  preApprovedTestClasses: ['header-audit'],
  defaultBudgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 3600000 },
  testWindows: [{ cron: '0 2 * * 1-5', timezone: 'Europe/Berlin', durationMs: 7200000 }],
  validFrom: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  requesterId: '0198f0a0-0000-7000-8000-0000000000a2',
  approverId: null,
  signature: null,
  signingKeyId: null,
  status: 'draft',
  revocationReason: null,
  version: 1,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
};

/** The shared error set of the mutating routes: every code the service can answer with. */
const MUTATION_ERRORS: readonly ErrorCode[] = [
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'PRECONDITION_REQUIRED',
  'PRECONDITION_FAILED',
  'AUTHZ_NOT_DRAFT',
  'AUTHZ_ILLEGAL_TRANSITION',
  'AUTHZ_INVALID_WINDOW',
  'AUTHZ_ASSET_UNVERIFIED',
  'SCOPE_INVALID_CLASS',
  'SCOPE_DESTRUCTIVE_FORBIDDEN',
];

/** Standing authorisations (AUTHZ-002): draft, read, list, patch and submit for approval. */
export function standingAuthorisationsOpenApiModule(): OpenApiModule {
  const schemas: JsonObject = {};
  registerSchema(schemas, 'StandingAuthorisation', standingAuthorisationDtoSchema);
  registerSchema(schemas, 'CreateStandingAuthorisation', createStandingAuthorisationSchema);
  registerSchema(schemas, 'PatchStandingAuthorisation', patchStandingAuthorisationSchema);
  const single = (description: string): JsonObject => ({
    description,
    headers: ETAG_HEADER,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/StandingAuthorisation' },
        examples: { current: { summary: 'A draft standing authorisation', value: EXAMPLE_SA } },
      },
    },
  });
  const body = (name: string): JsonObject => ({
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
  });
  const tag = ['standing-authorisations'];
  return {
    tag: 'standing-authorisations',
    description:
      'Standing authorisations (AUTHZ-002): the customer-signed, expiring permission to test assets. Drafts are created, read, changed and submitted for approval here.',
    paths: {
      [BASE]: {
        post: {
          operationId: 'createStandingAuthorisation',
          tags: tag,
          summary: 'Create a draft standing authorisation',
          description:
            'Requires Idempotency-Key. The caller becomes the requester. The draft is not yet approved or signed.',
          security: SECURITY,
          parameters: [IDEMPOTENCY_KEY_PARAM],
          requestBody: body('CreateStandingAuthorisation'),
          responses: {
            '201': single('The new draft and its ETag.'),
            ...errorResponses([
              'IDEMPOTENCY_KEY_REQUIRED',
              'IDEMPOTENCY_KEY_MISMATCH',
              ...MUTATION_ERRORS,
            ]),
          },
        },
        get: {
          operationId: 'listStandingAuthorisations',
          tags: tag,
          summary: 'List standing authorisations',
          description: 'Cursor-paginated, in id order. nextCursor is null on the last page.',
          security: SECURITY,
          parameters: [
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string', minLength: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200 },
            },
          ],
          responses: {
            '200': {
              description: 'One page of standing authorisations.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items', 'nextCursor', 'hasMore'],
                    properties: {
                      items: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/StandingAuthorisation' },
                      },
                      nextCursor: { type: ['string', 'null'] },
                      hasMore: { type: 'boolean' },
                    },
                  },
                  examples: {
                    onePage: {
                      summary: 'A single, last page',
                      value: { items: [EXAMPLE_SA], nextCursor: null, hasMore: false },
                    },
                  },
                },
              },
            },
            ...errorResponses(['VALIDATION_FAILED', 'INVALID_CURSOR', 'FORBIDDEN']),
          },
        },
      },
      [ITEM]: {
        get: {
          operationId: 'getStandingAuthorisation',
          tags: tag,
          summary: 'Read one standing authorisation',
          security: SECURITY,
          parameters: [ID_PARAM],
          responses: {
            '200': single('The standing authorisation and its ETag.'),
            ...errorResponses(['FORBIDDEN', 'NOT_FOUND']),
          },
        },
        patch: {
          operationId: 'updateStandingAuthorisation',
          tags: tag,
          summary: 'Change a draft standing authorisation',
          description:
            'Requires If-Match. Only a draft can change (409 otherwise). Unknown keys are refused. An empty body is refused.',
          security: SECURITY,
          parameters: [ID_PARAM, IF_MATCH_PARAM],
          requestBody: body('PatchStandingAuthorisation'),
          responses: {
            '200': single('The draft after the change and its new ETag.'),
            ...errorResponses(MUTATION_ERRORS),
          },
        },
      },
      [SUBMIT]: {
        post: {
          operationId: 'submitStandingAuthorisation',
          tags: tag,
          summary: 'Submit a draft for approval',
          description:
            'Requires If-Match. Moves the draft to pending_approval. Every asset must be verified for the tenant.',
          security: SECURITY,
          parameters: [ID_PARAM, IF_MATCH_PARAM],
          responses: {
            '200': single('The standing authorisation in pending_approval and its ETag.'),
            ...errorResponses(MUTATION_ERRORS),
          },
        },
      },
    },
    schemas,
  };
}
