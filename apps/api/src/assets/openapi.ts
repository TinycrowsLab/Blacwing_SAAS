import { assetListResponseSchema } from '@blackwing/contracts';

import { type OpenApiModule, jsonSchema } from '../openapi/schema.js';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const EXAMPLE_LIST = {
  items: [
    {
      id: '0198f0a0-0000-7000-8000-0000000000e1',
      name: 'Juice Shop (lab)',
      type: 'web_app',
      environment: 'dev',
      verificationStatus: 'verified',
    },
  ],
};

/** Assets (ASSET-017 scoping input): the read-only list the scoping wizard selects from. */
export function assetListOpenApiModule(): OpenApiModule {
  return {
    tag: 'assets',
    description:
      'Assets of the tenant, read-only. The scoping wizard lists the verified ones; an unverified asset cannot be targeted (§8.10).',
    paths: {
      '/v1/assets': {
        get: {
          operationId: 'listAssets',
          tags: ['assets'],
          summary: 'List the tenant assets, optionally filtered by verification state',
          description: 'Needs asset:read. Only the fields the scoping wizard needs are returned.',
          security: SECURITY,
          parameters: [
            {
              name: 'verificationStatus',
              in: 'query',
              required: false,
              description: 'Only assets in this verification state.',
              schema: { type: 'string', enum: ['unverified', 'pending', 'verified', 'rejected'] },
            },
          ],
          responses: {
            '200': {
              description: 'The assets of the caller tenant.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AssetList' },
                  examples: { verified: { summary: 'One verified asset', value: EXAMPLE_LIST } },
                },
              },
            },
            '400': {
              description: 'The query has an unknown or invalid parameter.',
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/Problem' },
                },
              },
            },
            '403': {
              description: 'The caller may not read assets in this tenant.',
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/Problem' },
                },
              },
            },
          },
        },
      },
    },
    schemas: {
      AssetList: jsonSchema(assetListResponseSchema),
    },
  };
}
