import {
  serviceAccountCreateSchema,
  serviceAccountSchema,
  serviceAccountUpdateSchema,
} from '@blackwing/contracts';

import {
  type JsonObject,
  type OpenApiModule,
  errorResponses,
  jsonSchema,
} from '../openapi/schema.js';

const COLLECTION = '/v1/service-accounts';
const ITEM = `${COLLECTION}/{id}`;

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const ID_PARAMETER: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The id of the service account (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const IF_MATCH_PARAMETER: JsonObject = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description:
    'The ETag of the service account being changed (from GET). A stale value answers 412, a missing one 428.',
  schema: { type: 'string', minLength: 1 },
  example: '"0"',
};

const ETAG_HEADER: JsonObject = {
  ETag: {
    description:
      'Strong validator of this service account state. Send it in If-Match on PATCH or DELETE.',
    schema: { type: 'string' },
  },
};

const EXAMPLE_ACCOUNT = {
  id: '0198f0a0-0000-7000-8000-0000000000a1',
  name: 'ci-scanner',
  description: 'Runs the nightly regression scan.',
  roles: ['ci_pipeline'],
  ownerUserId: '0198f0a0-0000-7000-8000-0000000000b1',
  status: 'active',
  stateVersion: 0,
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z',
};

const accountResponse = (description: string): JsonObject => ({
  description,
  headers: ETAG_HEADER,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ServiceAccount' },
      examples: { current: { summary: 'An active CI service account', value: EXAMPLE_ACCOUNT } },
    },
  },
});

/** Service accounts (RBAC-005): non-human tenant principals with a least-privilege role set. */
export function serviceAccountOpenApiModule(): OpenApiModule {
  return {
    tag: 'rbac',
    description:
      'Service accounts: non-human tenant principals that own API and CI tokens. Approval and administrative roles are refused.',
    paths: {
      [COLLECTION]: {
        get: {
          operationId: 'listServiceAccounts',
          tags: ['rbac'],
          summary: 'List the service accounts of the tenant',
          security: SECURITY,
          parameters: [
            {
              name: 'cursor',
              in: 'query',
              required: false,
              description: 'Opaque cursor from the previous page `nextCursor`.',
              schema: { type: 'string', maxLength: 512 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Page size, 1 to 200 (default 50).',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'One page of service accounts.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items', 'nextCursor'],
                    properties: {
                      items: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ServiceAccount' },
                      },
                      nextCursor: { type: ['string', 'null'] },
                    },
                  },
                  examples: {
                    page: {
                      summary: 'One active CI service account, no further pages',
                      value: { items: [EXAMPLE_ACCOUNT], nextCursor: null },
                    },
                  },
                },
              },
            },
            ...errorResponses(['VALIDATION_FAILED', 'INVALID_CURSOR', 'FORBIDDEN']),
          },
        },
        post: {
          operationId: 'createServiceAccount',
          tags: ['rbac'],
          summary: 'Create a service account',
          description:
            'The name is unique per tenant (409 when taken). The owner must be a member of the tenant (422 otherwise). Approval and administrative roles are refused (422).',
          security: SECURITY,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ServiceAccountCreate' },
                examples: {
                  ci: {
                    summary: 'A least-privilege CI account',
                    value: {
                      name: 'ci-scanner',
                      roles: ['ci_pipeline'],
                      ownerUserId: EXAMPLE_ACCOUNT.ownerUserId,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': accountResponse('The created service account at stateVersion 0.'),
            ...errorResponses(['VALIDATION_FAILED', 'FORBIDDEN', 'CONFLICT']),
          },
        },
      },
      [ITEM]: {
        get: {
          operationId: 'getServiceAccount',
          tags: ['rbac'],
          summary: 'Read a service account',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          responses: {
            '200': accountResponse('The service account and its ETag.'),
            ...errorResponses(['VALIDATION_FAILED', 'FORBIDDEN', 'NOT_FOUND']),
          },
        },
        patch: {
          operationId: 'updateServiceAccount',
          tags: ['rbac'],
          summary: 'Change a service account',
          description:
            'Requires If-Match. Changes the name, description, roles or status (set `disabled` to disable). The owner is not writable.',
          security: SECURITY,
          parameters: [ID_PARAMETER, IF_MATCH_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ServiceAccountUpdate' },
              },
            },
          },
          responses: {
            '200': accountResponse('The service account after the change and its new ETag.'),
            ...errorResponses([
              'VALIDATION_FAILED',
              'FORBIDDEN',
              'NOT_FOUND',
              'CONFLICT',
              'PRECONDITION_FAILED',
              'PRECONDITION_REQUIRED',
            ]),
          },
        },
        delete: {
          operationId: 'disableServiceAccount',
          tags: ['rbac'],
          summary: 'Disable a service account (soft delete)',
          description:
            'Sets status to disabled. Nothing is removed. A disabled account authenticates nothing. Requires If-Match.',
          security: SECURITY,
          parameters: [ID_PARAMETER, IF_MATCH_PARAMETER],
          responses: {
            '200': accountResponse('The disabled service account and its new ETag.'),
            ...errorResponses([
              'VALIDATION_FAILED',
              'FORBIDDEN',
              'NOT_FOUND',
              'PRECONDITION_FAILED',
              'PRECONDITION_REQUIRED',
            ]),
          },
        },
      },
    },
    schemas: {
      ServiceAccount: jsonSchema(serviceAccountSchema),
      ServiceAccountCreate: jsonSchema(serviceAccountCreateSchema),
      ServiceAccountUpdate: jsonSchema(serviceAccountUpdateSchema),
    },
  };
}
