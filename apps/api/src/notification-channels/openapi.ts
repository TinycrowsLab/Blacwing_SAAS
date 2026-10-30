import {
  createNotificationChannelSchema,
  notificationChannelViewSchema,
  updateNotificationChannelSchema,
} from '@blackwing/contracts';

import {
  errorResponses,
  type JsonObject,
  jsonSchema,
  type OpenApiModule,
} from '../openapi/schema.js';

const COLLECTION = '/v1/notification-channels';
const ITEM = '/v1/notification-channels/{id}';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

/** Error codes a channel write can answer. The problem `code` names which one applies. */
const CHANNEL_ERROR_CODES = [
  'FORBIDDEN',
  'NOT_FOUND',
  'NOTIFICATION_CHANNEL_INVALID',
  'CHANNEL_NAME_CONFLICT',
  'CHANNEL_SECRET_UNAVAILABLE',
  'CHANNEL_REFERENCED',
  'KEK_UNAVAILABLE',
] as const;

const ID_PARAMETER: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The channel id (UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const EXAMPLE_CHANNEL = {
  id: '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a77',
  kind: 'slack',
  name: 'Gate alerts',
  status: 'active',
  config: { channel: 'appsec-alerts' },
  secretRef:
    'bw-secret://018f5c2e-0000-7000-8000-000000000001/018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a88',
  createdBy: '018f5c2e-0000-7000-8000-000000000002',
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
};

/** Notification channels (NOTIFY-001): where Blackwing delivers notices, with credentials held by reference. */
export function notificationChannelsOpenApiModule(): OpenApiModule {
  const channel = (description: string): JsonObject => ({
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/NotificationChannel' },
        examples: { channel: { summary: 'A Slack channel', value: EXAMPLE_CHANNEL } },
      },
    },
  });
  return {
    tag: 'notifications',
    description:
      'Notification channels: email, Slack, Teams, webhook, PagerDuty and Opsgenie destinations. A credential is sent once as `secret`, stored by reference and never returned.',
    paths: {
      [COLLECTION]: {
        get: {
          operationId: 'listNotificationChannels',
          tags: ['notifications'],
          summary: 'List the notification channels',
          security: SECURITY,
          responses: {
            '200': {
              description: 'The tenant channels, oldest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items'],
                    properties: {
                      items: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/NotificationChannel' },
                      },
                    },
                  },
                  examples: {
                    channels: { summary: 'One Slack channel', value: { items: [EXAMPLE_CHANNEL] } },
                  },
                },
              },
            },
            ...errorResponses(['FORBIDDEN']),
          },
        },
        post: {
          operationId: 'createNotificationChannel',
          tags: ['notifications'],
          summary: 'Create a notification channel',
          description:
            'Requires notifications:manage. A secret-bearing kind must send `secret`; it is sealed into the secrets service and only its secret_ref is stored. Email must not send `secret`.',
          security: SECURITY,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateNotificationChannel' },
                examples: {
                  slack: {
                    summary: 'Slack webhook',
                    value: {
                      kind: 'slack',
                      name: 'Gate alerts',
                      config: { channel: 'appsec-alerts' },
                      secret: 'https://hooks.slack.com/services/T000/B000/XXXX',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': channel('The channel as stored, with its secret_ref and no secret material.'),
            ...errorResponses(CHANNEL_ERROR_CODES),
          },
        },
      },
      [ITEM]: {
        get: {
          operationId: 'getNotificationChannel',
          tags: ['notifications'],
          summary: 'Read a notification channel',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          responses: {
            '200': channel('The channel.'),
            ...errorResponses(['FORBIDDEN', 'NOT_FOUND']),
          },
        },
        patch: {
          operationId: 'updateNotificationChannel',
          tags: ['notifications'],
          summary: 'Change a notification channel',
          description:
            'Requires notifications:manage. `config` replaces the settings and is validated for the channel kind. `secret` rotates the credential to a new version. `status` enables or disables delivery. The kind cannot change.',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateNotificationChannel' },
                examples: {
                  disable: { summary: 'Disable delivery', value: { status: 'disabled' } },
                },
              },
            },
          },
          responses: {
            '200': channel('The channel after the change. An unchanged body returns it as is.'),
            ...errorResponses(CHANNEL_ERROR_CODES),
          },
        },
        delete: {
          operationId: 'deleteNotificationChannel',
          tags: ['notifications'],
          summary: 'Disable a notification channel',
          description:
            'Soft-disables the channel; the row and its credential are kept. A channel referenced by active routing rules answers 409 CHANNEL_REFERENCED unless `force=true`.',
          security: SECURITY,
          parameters: [
            ID_PARAMETER,
            {
              name: 'force',
              in: 'query',
              required: false,
              description: 'Disable the channel even when active routing rules reference it.',
              schema: { type: 'string', enum: ['true', 'false'], default: 'false' },
            },
          ],
          responses: {
            '200': channel('The channel, now disabled.'),
            ...errorResponses(['FORBIDDEN', 'NOT_FOUND', 'CHANNEL_REFERENCED']),
          },
        },
      },
    },
    schemas: {
      NotificationChannel: jsonSchema(notificationChannelViewSchema),
      CreateNotificationChannel: jsonSchema(createNotificationChannelSchema),
      UpdateNotificationChannel: jsonSchema(updateNotificationChannelSchema),
    },
  };
}
