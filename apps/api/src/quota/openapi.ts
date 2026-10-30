import { type JsonObject, type OpenApiModule, errorResponses } from '../openapi/schema.js';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const EXAMPLE_QUOTAS = {
  plan: 'free',
  assets: { used: 2, limit: 3 },
  concurrentRuns: { used: 0, limit: 1 },
  members: { used: 2, limit: 3 },
  monthlyCostUsd: {
    used: 12.5,
    limit: 50,
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
  },
};

const COUNT_QUOTA = {
  type: 'object',
  required: ['used', 'limit'],
  additionalProperties: false,
  properties: {
    used: { type: 'integer', minimum: 0, description: 'Current usage of the resource.' },
    limit: {
      type: ['integer', 'null'],
      minimum: 0,
      description: 'The plan limit; null means unlimited.',
    },
  },
};

/** Plan quotas (TENANT-009): used against limit for the console. Read-only; the plan is set by the platform operator. */
export function quotaOpenApiModule(): OpenApiModule {
  return {
    tag: 'quotas',
    description:
      'Plan quotas: the tenant plan, current usage against each limit, and the month-to-date cost against the monthly cap (UTC).',
    paths: {
      '/v1/tenant/quotas': {
        get: {
          operationId: 'getTenantQuotas',
          tags: ['quotas'],
          summary: 'Read the plan quotas and current usage of the caller tenant',
          description:
            'Requires the settings:read permission (org_admin). Counts are tenant-scoped. Creations past a limit are refused with 409 quota_exceeded (402 cost_cap_exceeded for the monthly cap).',
          security: SECURITY,
          responses: {
            '200': {
              description: 'The plan, the usage per resource and the monthly cost against its cap.',
              headers: {
                'cache-control': {
                  description: 'Always no-store: the answer is per tenant.',
                  schema: { type: 'string' },
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TenantQuotas' },
                  examples: { free: { summary: 'Free plan', value: EXAMPLE_QUOTAS } },
                },
              },
            },
            ...errorResponses(['FORBIDDEN_ROLE', 'INTERNAL']),
          },
        },
      },
    },
    schemas: {
      TenantQuotas: {
        type: 'object',
        required: ['plan', 'assets', 'concurrentRuns', 'members', 'monthlyCostUsd'],
        additionalProperties: false,
        properties: {
          plan: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
          assets: COUNT_QUOTA,
          concurrentRuns: COUNT_QUOTA,
          members: COUNT_QUOTA,
          monthlyCostUsd: {
            type: 'object',
            required: ['used', 'limit', 'periodStart', 'periodEnd'],
            additionalProperties: false,
            properties: {
              used: { type: 'number', minimum: 0 },
              limit: { type: ['number', 'null'], minimum: 0 },
              periodStart: { type: 'string', format: 'date-time' },
              periodEnd: { type: 'string', format: 'date-time' },
            },
          },
        },
      } satisfies JsonObject,
    },
  };
}
