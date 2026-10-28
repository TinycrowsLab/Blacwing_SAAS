import {
  idempotencyKeySchema,
  signupAcceptedSchema,
  signupRequestSchema,
  signupVerifiedSchema,
  signupVerifyRequestSchema,
} from '@blackwing/contracts';

import {
  errorResponses,
  type JsonObject,
  jsonSchema,
  type OpenApiModule,
  registerSchema,
} from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

const SIGNUP_ROUTE = '/v1/signup';
const SIGNUP_VERIFY_ROUTE = `${SIGNUP_ROUTE}/verify`;

/** No credentials are needed: `{}` is the OpenAPI way to say "this operation is anonymous". */
const ANONYMOUS: readonly JsonObject[] = [{}];

const REQUEST_ERROR_CODES = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_MISMATCH',
  'RATE_LIMITED',
] as const satisfies readonly ErrorCode[];

const VERIFY_ERROR_CODES = [
  'SIGNUP_TOKEN_INVALID',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_TOKEN = 'k3mT0xq9m1b1Vd2u7Rj8nQe4wYc6ZaPfH5sLgUoXiBA';
const EXAMPLE_TENANT = '01890a5d-ac96-774b-bcce-b302099a8057';

/** The self-service signup routes (TENANT-004) as a module of the public OpenAPI document. */
export function signupOpenApiModule(): OpenApiModule {
  const schemas: JsonObject = {};
  registerSchema(schemas, 'SignupRequest', signupRequestSchema);
  registerSchema(schemas, 'SignupAccepted', signupAcceptedSchema);
  registerSchema(schemas, 'SignupVerifyRequest', signupVerifyRequestSchema);
  registerSchema(schemas, 'SignupVerified', signupVerifiedSchema);
  return {
    tag: 'signup',
    description:
      'Self-service signup: verify an e-mail address, then create the organisation and its owner.',
    schemas,
    paths: {
      [SIGNUP_ROUTE]: {
        post: {
          operationId: 'requestSignup',
          summary: 'Ask for a verification e-mail to create an organisation',
          description:
            'Always answers 202 with the same body, whether or not the address already has an account, so the endpoint cannot be used to enumerate customers. A verification link is mailed; nothing is created until it is used.',
          security: ANONYMOUS,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: jsonSchema(idempotencyKeySchema),
              example: 'signup-7f3c2a9e-1',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SignupRequest' },
                example: { email: 'owner@acme.example', orgName: 'Acme Security' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Verification requested.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SignupAccepted' },
                  example: { status: 'verification_requested' },
                },
              },
            },
            ...errorResponses(REQUEST_ERROR_CODES),
          },
        },
      },
      [SIGNUP_VERIFY_ROUTE]: {
        post: {
          operationId: 'verifySignup',
          summary: 'Verify the e-mail address and create the organisation',
          description:
            'Consumes the single-use token from the e-mail. An unknown, expired, used or cancelled token is 400 SIGNUP_TOKEN_INVALID and creates nothing. When the address already has an account no second tenant is created: the answer is existing_account and the caller goes to login.',
          security: ANONYMOUS,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SignupVerifyRequest' },
                example: { token: EXAMPLE_TOKEN },
              },
            },
          },
          responses: {
            '200': {
              description: 'The signup was verified.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SignupVerified' },
                  examples: {
                    created: {
                      value: {
                        outcome: 'tenant_created',
                        tenantId: EXAMPLE_TENANT,
                        slug: 'acme-security',
                      },
                    },
                    existing: { value: { outcome: 'existing_account' } },
                  },
                },
              },
            },
            ...errorResponses(VERIFY_ERROR_CODES),
          },
        },
      },
    },
  };
}
