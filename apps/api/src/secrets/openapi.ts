import {
  createSecretRequestSchema,
  idempotencyKeySchema,
  pageSchema,
  secretMetadataSchema,
  secretWriteResponseSchema,
  updateSecretRequestSchema,
} from '@blackwing/contracts';

import { SECRET_ROUTE, SECRETS_ROUTE } from './routes.js';
import { errorResponses, jsonSchema, type OpenApiModule } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** Error codes the secrets operations answer with beyond the standard set every operation documents. */
export const SECRET_CREATE_ERROR_CODES = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SECRET_NAME_CONFLICT',
  'SECRET_TOO_LARGE',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_MISMATCH',
  'KEK_UNAVAILABLE',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

export const SECRET_UPDATE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'SECRET_TOO_LARGE',
  'VALIDATION_FAILED',
  'KEK_UNAVAILABLE',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

export const SECRET_DELETE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'SECRET_IN_USE',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

export const SECRET_READ_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const EXAMPLE_TENANT = '01890a5d-ac96-774b-bcce-b302099a8058';
const EXAMPLE_REF = `bw-secret://${EXAMPLE_TENANT}/${EXAMPLE_ID}`;
const EXAMPLE_AT = '2026-10-22T10:00:00.000Z';

const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const metadataExample = {
  secretId: EXAMPLE_ID,
  secretRef: EXAMPLE_REF,
  name: 'staging-api-key',
  type: 'api_key',
  purpose: 'Authenticated scans of staging',
  backend: 'openbao',
  status: 'active',
  currentVersion: 1,
  createdAt: EXAMPLE_AT,
  updatedAt: EXAMPLE_AT,
};

const etagHeader = { ETag: { $ref: '#/components/headers/ETag' } };

/**
 * The write-only secrets API (SECRETS-004) as a module of the combined document, generated from the Zod
 * contracts. A value is accepted on create and update and never returned: callers receive a secret_ref and
 * metadata. Needs secret:write (create, update, delete) or secret:read (metadata) and the Cedar tenant check.
 */
export function secretsOpenApiModule(): OpenApiModule {
  return {
    tag: 'secrets',
    description:
      'Write-only secrets: create, replace and disable; metadata is readable, a value never is.',
    paths: {
      [SECRETS_ROUTE]: {
        post: {
          operationId: 'createSecret',
          summary: 'Create a secret',
          description:
            'Encrypts the value into the tenant envelope and answers with the secret_ref. The value is never returned and never logged. Idempotency-Key is required: a retry with the same key and body returns the first result.',
          security: SECURITY,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: jsonSchema(idempotencyKeySchema),
              example: 'secret-7f3c2a9e-1',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateSecretRequest' },
                examples: {
                  apiKey: {
                    summary: 'An API key',
                    value: {
                      name: 'staging-api-key',
                      type: 'api_key',
                      purpose: 'Authenticated scans of staging',
                      value: 'example-value-not-a-real-key',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created. The Location is the secret; no value is returned.',
              headers: {
                Location: { description: 'URL of the secret.', schema: { type: 'string' } },
                ...etagHeader,
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretWriteResponse' },
                  examples: {
                    created: {
                      value: { secretId: EXAMPLE_ID, secretRef: EXAMPLE_REF, version: 1 },
                    },
                  },
                },
              },
            },
            ...errorResponses(SECRET_CREATE_ERROR_CODES),
          },
        },
        get: {
          operationId: 'listSecrets',
          summary: 'List secret metadata',
          description:
            'Metadata only: never a value or an envelope. Cursor-paginated by creation order.',
          security: SECURITY,
          parameters: [
            { $ref: '#/components/parameters/Cursor' },
            { $ref: '#/components/parameters/Limit' },
          ],
          responses: {
            '200': {
              description: 'A page of secret metadata.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretMetadataPage' },
                  examples: {
                    page: {
                      value: { items: [metadataExample], nextCursor: null, hasMore: false },
                    },
                  },
                },
              },
            },
            ...errorResponses(SECRET_READ_ERROR_CODES),
          },
        },
      },
      [SECRET_ROUTE.replace(':id', '{id}')]: {
        get: {
          operationId: 'getSecret',
          summary: 'Read secret metadata',
          description: 'Metadata only: there is no way to read a value back.',
          security: SECURITY,
          parameters: [idParameter],
          responses: {
            '200': {
              description: 'The secret metadata.',
              headers: etagHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretMetadata' },
                  examples: { metadata: { value: metadataExample } },
                },
              },
            },
            ...errorResponses(SECRET_READ_ERROR_CODES),
          },
        },
        put: {
          operationId: 'updateSecret',
          summary: 'Replace a secret value',
          description:
            'Stores the value as a new version and increments currentVersion. If-Match is optional: send the ETag of the version you read to fail with 412 when someone else updated first.',
          security: SECURITY,
          parameters: [
            idParameter,
            {
              name: 'If-Match',
              in: 'header',
              required: false,
              description: 'ETag of the version being replaced; a stale value answers 412.',
              schema: { type: 'string', minLength: 1 },
              example: '"v1"',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateSecretRequest' },
                examples: { replace: { value: { value: 'another-example-value' } } },
              },
            },
          },
          responses: {
            '200': {
              description: 'The new version; no value is returned.',
              headers: etagHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretWriteResponse' },
                  examples: {
                    updated: {
                      value: { secretId: EXAMPLE_ID, secretRef: EXAMPLE_REF, version: 2 },
                    },
                  },
                },
              },
            },
            ...errorResponses(SECRET_UPDATE_ERROR_CODES),
          },
        },
        delete: {
          operationId: 'deleteSecret',
          summary: 'Disable a secret',
          description:
            'Soft delete: sets status to disabled. A secret that other resources still reference answers 409 SECRET_IN_USE, naming the resource types; repeat with force=true to disable it anyway. Hard delete only happens through the shred flow.',
          security: SECURITY,
          parameters: [
            idParameter,
            {
              name: 'force',
              in: 'query',
              required: false,
              description: 'Disable even though the secret is still referenced.',
              schema: { type: 'boolean', default: false },
              example: false,
            },
          ],
          responses: {
            '200': {
              description: 'The secret, now disabled (also when it already was).',
              headers: etagHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretMetadata' },
                  examples: {
                    disabled: { value: { ...metadataExample, status: 'disabled' } },
                  },
                },
              },
            },
            ...errorResponses(SECRET_DELETE_ERROR_CODES),
          },
        },
      },
    },
    schemas: {
      CreateSecretRequest: jsonSchema(createSecretRequestSchema),
      UpdateSecretRequest: jsonSchema(updateSecretRequestSchema),
      SecretWriteResponse: jsonSchema(secretWriteResponseSchema),
      SecretMetadata: jsonSchema(secretMetadataSchema),
      SecretMetadataPage: jsonSchema(pageSchema(secretMetadataSchema)),
    },
  };
}
