import {
  idempotencyKeySchema,
  killTriggerResponseSchema,
  operatorBlastRadiusSchema,
  operatorKillEventDetailSchema,
  operatorKillEventListSchema,
  operatorKillRequestSchema,
  operatorKillScopeSchema,
  problemSchema,
} from '@blackwing/contracts';

import {
  OPERATOR_BLAST_RADIUS_ROUTE,
  OPERATOR_KILL_EVENTS_ROUTE,
  OPERATOR_KILL_ROUTE,
} from './routes.js';
import { errorResponses, type JsonObject, jsonSchema } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

const AUTH_ERRORS = ['UNAUTHENTICATED', 'NOT_OPERATOR', 'INTERNAL'] as const;

const EXAMPLE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const EXAMPLE_TENANT = '01890a5d-ac96-774b-bcce-b302099a8058';
const EXAMPLE_AT = '2026-10-20T10:00:00.000Z';

const security = [{ operatorSession: [] }];
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const body = (name: string): JsonObject => ({
  required: true,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
});
const ok = (description: string, name: string, example?: unknown): JsonObject => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: `#/components/schemas/${name}` },
      ...(example === undefined ? {} : { example }),
    },
  },
});

/** Error codes `POST /operator/v1/kill` can answer with. */
const FIRE_ERRORS = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'UNAUTHENTICATED',
  'NOT_OPERATOR',
  'NOT_FOUND',
  'KILL_ALREADY_IN_PROGRESS',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_MISMATCH',
  'KILL_PARTIAL',
  'INTERNAL',
  'TEMPORAL_UNAVAILABLE',
] as const satisfies readonly ErrorCode[];

/** The OpenAPI 3.1 document for the operator kill control, generated from the Zod contracts. */
export function operatorKillOpenApiDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Blackwing operator API: global kill control',
      version: '1.0.0',
      description:
        'Platform-operator kill (F33, §1.2, §8.5). Triggers the deterministic kill path and reports what it measured. Operator-only: a tenant session is refused with NOT_OPERATOR.',
    },
    paths: {
      [OPERATOR_BLAST_RADIUS_ROUTE]: {
        get: {
          operationId: 'previewOperatorKill',
          summary: 'What a global or tenant kill would stop right now',
          description:
            'Audited as operator.kill_previewed. tenantSlug is present for scope=tenant.',
          security,
          parameters: [
            {
              name: 'scope',
              in: 'query',
              required: true,
              schema: jsonSchema(operatorKillScopeSchema),
            },
            {
              name: 'tenantId',
              in: 'query',
              required: false,
              description: 'Required for scope=tenant; forbidden for scope=global.',
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': ok('The blast radius.', 'OperatorBlastRadius', {
              runsAffected: 3,
              sandboxesAffected: 5,
              tenantsAffected: 2,
              sessionsAffected: 4,
            }),
            ...errorResponses([...AUTH_ERRORS, 'NOT_FOUND', 'VALIDATION_FAILED']),
          },
        },
      },
      [OPERATOR_KILL_ROUTE]: {
        post: {
          operationId: 'fireOperatorKill',
          summary: 'Fire a global or tenant kill',
          description:
            'Propagation is asynchronous: poll the Location. A repeat of the same Idempotency-Key replays the first answer; another kill for a scope that already has one open is KILL_ALREADY_IN_PROGRESS. Audited as operator.kill_fired in the operator and affected-tenant streams.',
          security,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: jsonSchema(idempotencyKeySchema),
              example: 'opkill-7f3c2a9e-1',
            },
          ],
          requestBody: {
            ...body('OperatorKillRequest'),
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OperatorKillRequest' },
                examples: {
                  global: { value: { scope: 'global', reason: 'platform incident' } },
                  tenant: {
                    value: {
                      scope: 'tenant',
                      tenantId: EXAMPLE_TENANT,
                      reason: 'customer request',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '202': {
              ...ok(
                'Kill accepted. status is halted when nothing in scope was running.',
                'KillTriggerResponse',
                {
                  killEventId: EXAMPLE_ID,
                  status: 'initiated',
                  triggeredAt: EXAMPLE_AT,
                },
              ),
              headers: {
                Location: {
                  description: 'URL of the kill event, /operator/v1/kill/events/{killEventId}.',
                  schema: { type: 'string' },
                },
              },
            },
            ...errorResponses(FIRE_ERRORS),
          },
        },
      },
      [OPERATOR_KILL_EVENTS_ROUTE]: {
        get: {
          operationId: 'listOperatorKillEvents',
          summary: 'Prior operator kills, newest first (at most 50)',
          security,
          responses: {
            '200': ok('The kill history.', 'OperatorKillEventList'),
            ...errorResponses(AUTH_ERRORS),
          },
        },
      },
      [`${OPERATOR_KILL_EVENTS_ROUTE}/{id}`]: {
        get: {
          operationId: 'getOperatorKillEvent',
          summary: 'One kill with its measured phases and per-component results',
          description:
            'A phase timestamp is null until the kill path confirmed it. status partially_halted or failed means components are still running; affected names them.',
          security,
          parameters: [idParam],
          responses: {
            '200': ok('The kill event.', 'OperatorKillEventDetail'),
            ...errorResponses([...AUTH_ERRORS, 'NOT_FOUND']),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        operatorSession: { type: 'apiKey', in: 'cookie', name: 'bw_operator_session' },
      },
      schemas: {
        OperatorBlastRadius: jsonSchema(operatorBlastRadiusSchema),
        OperatorKillRequest: jsonSchema(operatorKillRequestSchema),
        KillTriggerResponse: jsonSchema(killTriggerResponseSchema),
        OperatorKillEventList: jsonSchema(operatorKillEventListSchema),
        OperatorKillEventDetail: jsonSchema(operatorKillEventDetailSchema),
        Problem: jsonSchema(problemSchema),
      },
    },
  };
}
