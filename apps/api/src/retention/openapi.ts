import { retentionPolicyUpdateSchema, retentionPolicySetSchema } from '@blackwing/contracts';

import { RETENTION_POLICIES_ROUTE } from './routes.js';
import { errorResponses, type JsonObject, jsonSchema } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** Error codes `GET /v1/retention-policies` can answer with. */
const RETENTION_GET_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Error codes `PUT /v1/retention-policies` can answer with. */
const RETENTION_PUT_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'VALIDATION_FAILED',
  'PRECONDITION_REQUIRED',
  'PRECONDITION_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_AT = '2026-10-28T09:00:00.000Z';

/** The OpenAPI 3.1 document for the retention policy API, generated from the Zod contracts. */
export function retentionOpenApiDocument(): JsonObject {
  const etagHeader = {
    description: 'Strong ETag of the policy set; send it back in If-Match on PUT.',
    schema: { type: 'string' },
    example: '"4f1c2d9a8b7e6f50"',
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Blackwing control-plane API: retention policies',
      version: '1.0.0',
      description:
        'Per-tenant retention per data class (RETAIN-001). Floors are platform minimums; legal hold always wins.',
    },
    paths: {
      [RETENTION_POLICIES_ROUTE]: {
        get: {
          operationId: 'getRetentionPolicies',
          summary: 'Read the effective retention policy of every data class',
          description:
            'Requires settings:read. A class without a stored row shows the platform default.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          responses: {
            '200': {
              description: 'The effective policy set.',
              headers: { ETag: etagHeader },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RetentionPolicySet' },
                  examples: {
                    defaults: {
                      summary: 'A tenant that has not changed its policies',
                      value: {
                        policies: [
                          {
                            dataClass: 'findings',
                            retentionDays: 730,
                            minRetentionDays: 90,
                            enabled: true,
                            legalHoldOverrides: false,
                            updatedAt: EXAMPLE_AT,
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(RETENTION_GET_ERROR_CODES),
          },
        },
        put: {
          operationId: 'updateRetentionPolicies',
          summary: 'Change the retention of one or more data classes',
          description:
            'Requires settings:write and If-Match. Each class may appear once. Values below the platform floor are rejected; enabled:false sets the floor. Changed classes are audited.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              description: 'The ETag from the GET this change is based on.',
              schema: { type: 'string', minLength: 1 },
              example: '"4f1c2d9a8b7e6f50"',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RetentionPolicyUpdate' },
                examples: {
                  shorten: {
                    summary: 'Shorten evidence to 60 days',
                    value: {
                      policies: [{ dataClass: 'evidence', retentionDays: 60, enabled: true }],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The policy set after the change.',
              headers: { ETag: etagHeader },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RetentionPolicySet' },
                },
              },
            },
            ...errorResponses(RETENTION_PUT_ERROR_CODES),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'bw_pat_ or bw_ci_ token' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'bw_session' },
      },
      schemas: {
        RetentionPolicySet: jsonSchema(retentionPolicySetSchema),
        RetentionPolicyUpdate: jsonSchema(retentionPolicyUpdateSchema),
      },
    },
  };
}
