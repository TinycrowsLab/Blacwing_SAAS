import {
  tenantSettingsPatchSchema,
  tenantSettingsResponseSchema,
  tenantSettingsSchema,
} from '@blackwing/contracts';

import { type JsonObject, type OpenApiModule, jsonSchema } from '../openapi/schema.js';

const PATH = '/v1/tenant/settings';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const EXAMPLE_RESPONSE = {
  settings: { displayTimezone: 'Europe/Berlin', defaultAssessmentMode: 'grey', weekStartsOn: 1 },
  region: 'eu-west-1',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

/** The `ETag` a read or a change answers with; send it back in `If-Match` to change the settings. */
const ETAG_HEADER: JsonObject = {
  ETag: {
    description: 'Strong validator of this settings state. Send it in If-Match on PATCH.',
    schema: { type: 'string' },
  },
};

/** Settings (TENANT-008): the tenant's display timezone, defaults and read-only data region. */
export function tenantSettingsOpenApiModule(): OpenApiModule {
  const response = (description: string): JsonObject => ({
    description,
    headers: ETAG_HEADER,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/TenantSettingsResponse' },
        examples: { current: { summary: 'Settings with a display zone', value: EXAMPLE_RESPONSE } },
      },
    },
  });
  return {
    tag: 'tenant',
    description:
      'Tenant settings: display timezone, default assessment mode and the read-only data region.',
    paths: {
      [PATH]: {
        get: {
          operationId: 'getTenantSettings',
          tags: ['tenant'],
          summary: 'Read the tenant settings',
          security: SECURITY,
          responses: { '200': response('The current settings, region and ETag.') },
        },
        patch: {
          operationId: 'updateTenantSettings',
          tags: ['tenant'],
          summary: 'Change the tenant settings',
          description:
            'Requires If-Match. Unknown keys and region are rejected. An unknown time zone answers invalid_timezone. An empty or unchanged body is a no-op.',
          security: SECURITY,
          parameters: [
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              description:
                'The ETag of the settings being changed (from GET). A stale value answers 412, a missing one 428.',
              schema: { type: 'string', minLength: 1 },
              example: '"3f9c2a1b8d7e6f50"',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TenantSettingsPatch' },
                examples: {
                  timezone: {
                    summary: 'Change the display zone',
                    value: { displayTimezone: 'Europe/Berlin' },
                  },
                },
              },
            },
          },
          responses: { '200': response('The settings after the change and the new ETag.') },
        },
      },
    },
    schemas: {
      TenantSettings: jsonSchema(tenantSettingsSchema),
      TenantSettingsPatch: jsonSchema(tenantSettingsPatchSchema),
      TenantSettingsResponse: jsonSchema(tenantSettingsResponseSchema),
    },
  };
}
