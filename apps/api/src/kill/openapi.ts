import {
  idempotencyKeySchema,
  killEventListSchema,
  killEventSchema,
  killTriggerRequestSchema,
  killTriggerResponseSchema,
  MAX_PAGE_LIMIT,
  problemSchema,
} from '@blackwing/contracts';

import { KILL_ROUTE } from './routes.js';
import { errorResponses, type JsonObject, jsonSchema } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** Error codes `POST /v1/kill` can answer with, by status. */
export const KILL_TRIGGER_ERROR_CODES = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'UNAUTHENTICATED',
  'KILL_FORBIDDEN',
  'KILL_GLOBAL_NOT_ALLOWED_HERE',
  'NOT_FOUND',
  'KILL_SCOPE_INVALID',
  'KILL_REF_REQUIRED',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_MISMATCH',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Error codes `GET /v1/kill` can answer with. */
const KILL_LIST_ERROR_CODES = [
  'UNAUTHENTICATED',
  'KILL_FORBIDDEN',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Error codes `GET /v1/kill/{id}` can answer with. */
export const KILL_GET_ERROR_CODES = [
  'UNAUTHENTICATED',
  'KILL_FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const EXAMPLE_RUN = '01890a5d-ac96-774b-bcce-b302099a8058';
const EXAMPLE_AT = '2026-10-20T10:00:00.000Z';

function killEventViewSchema(): JsonObject {
  const base = jsonSchema(killEventSchema);
  const properties = { ...(base.properties as JsonObject) };
  const { id, ...others } = properties;
  const required = (base.required as string[]).map((name) =>
    name === 'id' ? 'killEventId' : name,
  );
  return { ...base, properties: { killEventId: id, ...others }, required };
}

/** The OpenAPI 3.1 document for the kill trigger API, generated from the Zod contracts. */
export function killOpenApiDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Blackwing control-plane API: kill switch',
      version: '1.0.0',
      description:
        'Tenant kill trigger (F33, §8.5). Global kills are platform-operator only and use another path.',
    },
    paths: {
      [KILL_ROUTE]: {
        post: {
          operationId: 'triggerKill',
          summary: 'Trigger the kill switch for a run, asset or the whole tenant',
          description:
            'Requires kill:trigger and the Cedar Kill::trigger resource check. An asset_owner may kill only assets they own; only org_admin may kill the tenant. Propagation is asynchronous: poll the Location.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: jsonSchema(idempotencyKeySchema),
              example: 'kill-7f3c2a9e-1',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/KillTriggerRequest' },
                examples: {
                  run: {
                    summary: 'Kill one run',
                    value: {
                      scope: 'run',
                      scopeRefId: EXAMPLE_RUN,
                      reason: 'unexpected 5xx spike',
                    },
                  },
                  asset: {
                    summary: 'Kill every run on an asset',
                    value: { scope: 'asset', scopeRefId: EXAMPLE_RUN, reason: 'change freeze' },
                  },
                  tenant: {
                    summary: 'Kill every run in the tenant',
                    value: { scope: 'tenant', reason: 'incident declared' },
                  },
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Kill accepted. status is halted when nothing in scope was running.',
              headers: {
                Location: {
                  description: 'URL of the kill event, /v1/kill/{killEventId}.',
                  schema: { type: 'string' },
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/KillTriggerResponse' },
                  examples: {
                    initiated: {
                      value: {
                        killEventId: EXAMPLE_ID,
                        status: 'initiated',
                        triggeredAt: EXAMPLE_AT,
                      },
                    },
                    nothingRunning: {
                      value: { killEventId: EXAMPLE_ID, status: 'halted', triggeredAt: EXAMPLE_AT },
                    },
                  },
                },
              },
            },
            ...errorResponses(KILL_TRIGGER_ERROR_CODES),
          },
        },
        get: {
          operationId: 'listKillEvents',
          summary: "The tenant's most recent kill events, newest first",
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'The kill history of the caller tenant, newest first.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/KillEventList' },
                  examples: {
                    history: {
                      summary: 'The newest kill of the tenant',
                      value: {
                        items: [
                          {
                            killEventId: EXAMPLE_ID,
                            tenantId: EXAMPLE_RUN,
                            scope: 'asset',
                            scopeRefId: EXAMPLE_RUN,
                            source: 'console',
                            actorType: 'user',
                            actorRef: EXAMPLE_RUN,
                            reason: 'change freeze',
                            status: 'initiated',
                            triggeredAt: EXAMPLE_AT,
                            egressBlockedAt: null,
                            sandboxesTerminatedAt: null,
                            keysRevokedAt: null,
                            workflowsCancelledAt: null,
                            completedAt: null,
                            haltMs: null,
                            affected: {},
                            reenabledAt: null,
                            reenabledBy: null,
                            createdAt: EXAMPLE_AT,
                            updatedAt: EXAMPLE_AT,
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(KILL_LIST_ERROR_CODES),
          },
        },
      },
      [`${KILL_ROUTE}/{id}`]: {
        get: {
          operationId: 'getKillEvent',
          summary: 'A kill event with its halt timings',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'The kill event.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/KillEvent' },
                  examples: {
                    halted: {
                      value: {
                        killEventId: EXAMPLE_ID,
                        tenantId: EXAMPLE_RUN,
                        scope: 'run',
                        scopeRefId: EXAMPLE_RUN,
                        source: 'api',
                        actorType: 'user',
                        actorRef: EXAMPLE_RUN,
                        reason: 'unexpected 5xx spike',
                        status: 'halted',
                        triggeredAt: EXAMPLE_AT,
                        egressBlockedAt: '2026-10-20T10:00:00.400Z',
                        sandboxesTerminatedAt: '2026-10-20T10:00:03.100Z',
                        keysRevokedAt: '2026-10-20T10:00:03.200Z',
                        workflowsCancelledAt: '2026-10-20T10:00:03.300Z',
                        completedAt: '2026-10-20T10:00:03.300Z',
                        haltMs: 3300,
                        affected: { runs: 1, sessions: 2, sandboxes: 2, keys: 2, workflows: 3 },
                        reenabledAt: null,
                        reenabledBy: null,
                        createdAt: EXAMPLE_AT,
                        updatedAt: '2026-10-20T10:00:03.300Z',
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(KILL_GET_ERROR_CODES),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'bw_pat_ or bw_ci_ token' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-bw_session' },
      },
      schemas: {
        KillTriggerRequest: jsonSchema(killTriggerRequestSchema),
        KillTriggerResponse: jsonSchema(killTriggerResponseSchema),
        KillEvent: killEventViewSchema(),
        KillEventList: jsonSchema(killEventListSchema),
        Problem: jsonSchema(problemSchema),
      },
    },
  };
}
