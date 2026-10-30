import { orgProfileSchema, orgSettingsPatchSchema } from '@blackwing/contracts';

import {
  type JsonObject,
  type OpenApiModule,
  errorResponses,
  jsonSchema,
} from '../openapi/schema.js';

const PATH = '/v1/tenants/current';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const EXAMPLE_PROFILE = {
  name: 'Acme Security',
  slug: 'acme',
  region: 'eu-west-1',
  plan: 'team',
  status: 'active',
  defaultTimezone: 'Europe/Berlin',
  supportContactEmail: 'soc@acme.test',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

/** The `ETag` a read or a change answers with; send it back in `If-Match` to change the profile. */
const ETAG_HEADER: JsonObject = {
  ETag: {
    description: 'Strong validator of this profile state. Send it in If-Match on PATCH.',
    schema: { type: 'string' },
  },
};

/** Organisation profile (ADMIN-001): the tenant's name, display zone and support contact. Admins only. */
export function tenantProfileOpenApiModule(): OpenApiModule {
  const response = (description: string): JsonObject => ({
    description,
    headers: ETAG_HEADER,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/OrgProfile' },
        examples: { current: { summary: 'Organisation profile', value: EXAMPLE_PROFILE } },
      },
    },
  });
  return {
    tag: 'organisation',
    description:
      'Organisation profile: name, display time zone and support contact. Slug, region, plan and status are read-only.',
    paths: {
      [PATH]: {
        get: {
          operationId: 'getCurrentTenant',
          tags: ['organisation'],
          summary: 'Read the organisation profile of the caller tenant',
          description:
            'Requires the settings:read permission (org_admin). The tenant comes from the session or token, never from the request.',
          security: SECURITY,
          responses: {
            '200': response('The current profile and its ETag.'),
            ...errorResponses(['FORBIDDEN_ROLE', 'NOT_FOUND']),
          },
        },
        patch: {
          operationId: 'updateCurrentTenant',
          tags: ['organisation'],
          summary: 'Change the organisation profile',
          description:
            'Requires If-Match and the settings:write permission (org_admin). Unknown keys, slug, region and plan are rejected. An empty or unchanged body is a no-op.',
          security: SECURITY,
          parameters: [
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              description:
                'The ETag of the profile being changed (from GET). A stale value answers 412 ETAG_MISMATCH, a missing one 428.',
              schema: { type: 'string', minLength: 1 },
              example: '"3f9c2a1b8d7e6f50"',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OrgSettingsPatch' },
                examples: {
                  rename: {
                    summary: 'Rename and clear the support contact',
                    value: { name: 'Acme Security Ltd', supportContactEmail: null },
                  },
                },
              },
            },
          },
          responses: {
            '200': response('The profile after the change and the new ETag.'),
            ...errorResponses([
              'FORBIDDEN_ROLE',
              'VALIDATION_FAILED',
              'PRECONDITION_REQUIRED',
              'ETAG_MISMATCH',
            ]),
          },
        },
      },
    },
    schemas: {
      OrgProfile: jsonSchema(orgProfileSchema),
      OrgSettingsPatch: jsonSchema(orgSettingsPatchSchema),
    },
  };
}
