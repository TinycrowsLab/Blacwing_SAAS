import {
  createNotificationRouteSchema,
  notificationRouteViewSchema,
  updateNotificationRouteSchema,
} from '@blackwing/contracts';

import {
  errorResponses,
  type JsonObject,
  jsonSchema,
  type OpenApiModule,
} from '../openapi/schema.js';

const COLLECTION = '/v1/notification-routes';
const ITEM = '/v1/notification-routes/{id}';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const ROUTE_ERROR_CODES = ['FORBIDDEN', 'NOT_FOUND', 'NOTIFICATION_ROUTE_INVALID'] as const;

const ID_PARAMETER: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The routing rule id (UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const EXAMPLE_ROUTE = {
  id: '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a91',
  event: 'kill.fired',
  assetId: null,
  severityMin: 'critical',
  channelId: '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a77',
  recipientSpec: { onCallGroup: 'soc-primary' },
  enabled: true,
  priority: 10,
  createdBy: '018f5c2e-0000-7000-8000-000000000002',
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
};

/**
 * Notification routing rules (NOTIFY-011): which events of a tenant reach which channel and recipients, optionally
 * narrowed by asset, severity and recipients. A rule names a channel by id and never a credential.
 */
export function notificationRoutesOpenApiModule(): OpenApiModule {
  const route = (description: string): JsonObject => ({
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/NotificationRoute' },
        examples: { route: { summary: 'SOC on-call for kill events', value: EXAMPLE_ROUTE } },
      },
    },
  });
  return {
    tag: 'notifications',
    description:
      'Notification routing rules: which events go to which channel, optionally per asset, severity and on-call group. A channel named by an enabled rule cannot be disabled without force.',
    paths: {
      [COLLECTION]: {
        get: {
          operationId: 'listNotificationRoutes',
          tags: ['notifications'],
          summary: 'List the notification routing rules',
          security: SECURITY,
          responses: {
            '200': {
              description: 'The tenant routing rules, in id order.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items'],
                    properties: {
                      items: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/NotificationRoute' },
                      },
                    },
                  },
                  examples: { routes: { summary: 'One rule', value: { items: [EXAMPLE_ROUTE] } } },
                },
              },
            },
            ...errorResponses(['FORBIDDEN']),
          },
        },
        post: {
          operationId: 'createNotificationRoute',
          tags: ['notifications'],
          summary: 'Create a notification routing rule',
          description:
            'Requires notifications:manage. The channel must be active in the tenant. `assetId` null (or absent) matches every asset; `event` `*` matches every event.',
          security: SECURITY,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateNotificationRoute' },
                examples: {
                  soc: {
                    summary: 'SOC on-call for kill events',
                    value: {
                      event: 'kill.fired',
                      severityMin: 'critical',
                      channelId: EXAMPLE_ROUTE.channelId,
                      recipientSpec: { onCallGroup: 'soc-primary' },
                      priority: 10,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': route('The rule as stored.'),
            ...errorResponses(ROUTE_ERROR_CODES),
          },
        },
      },
      [ITEM]: {
        get: {
          operationId: 'getNotificationRoute',
          tags: ['notifications'],
          summary: 'Read a notification routing rule',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          responses: {
            '200': route('The rule.'),
            ...errorResponses(['FORBIDDEN', 'NOT_FOUND']),
          },
        },
        patch: {
          operationId: 'updateNotificationRoute',
          tags: ['notifications'],
          summary: 'Change a notification routing rule',
          description:
            'Requires notifications:manage. Only the fields sent change. An empty body is refused. A channel change must name an active channel of the tenant.',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateNotificationRoute' },
                examples: { disable: { summary: 'Disable the rule', value: { enabled: false } } },
              },
            },
          },
          responses: {
            '200': route('The rule after the change. An unchanged body returns it as is.'),
            ...errorResponses(ROUTE_ERROR_CODES),
          },
        },
        delete: {
          operationId: 'deleteNotificationRoute',
          tags: ['notifications'],
          summary: 'Delete a notification routing rule',
          description: 'Removes the rule and audits the deletion.',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          responses: {
            '200': route('The rule that was removed.'),
            ...errorResponses(['FORBIDDEN', 'NOT_FOUND']),
          },
        },
      },
    },
    schemas: {
      NotificationRoute: jsonSchema(notificationRouteViewSchema),
      CreateNotificationRoute: jsonSchema(createNotificationRouteSchema),
      UpdateNotificationRoute: jsonSchema(updateNotificationRouteSchema),
    },
  };
}
