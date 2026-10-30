import {
  oncallRosterCreateSchema,
  oncallRosterPatchSchema,
  oncallRosterSchema,
  problemSchema,
} from '@blackwing/contracts';

import { errorResponses, type JsonObject, jsonSchema } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** The collection path, relative to the global `/v1` prefix (`controller.ts`). */
const ONCALL_ROSTERS_ROUTE = '/v1/oncall/rosters';

/** Error codes the read endpoints can answer with. */
export const ONCALL_READ_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Error codes `POST /v1/oncall/rosters` can answer with. */
export const ONCALL_CREATE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFLICT',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Error codes `PATCH /v1/oncall/rosters/{id}` can answer with. */
export const ONCALL_PATCH_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'PRECONDITION_REQUIRED',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const EXAMPLE_TENANT = '01890a5d-ac96-774b-bcce-b302099a8058';
const EXAMPLE_USER = '01890a5d-ac96-774b-bcce-b302099a8059';
const EXAMPLE_MANAGER = '01890a5d-ac96-774b-bcce-b302099a805a';
const EXAMPLE_CHANNEL = '01890a5d-ac96-774b-bcce-b302099a805b';
const EXAMPLE_AT = '2026-10-20T10:00:00.000Z';

const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];
const ROSTER_REF = { $ref: '#/components/schemas/OncallRoster' };

const rosterExample = {
  id: EXAMPLE_ID,
  tenantId: EXAMPLE_TENANT,
  name: 'Primary rotation',
  timezone: 'Europe/Berlin',
  active: true,
  stateVersion: 0,
  members: [
    {
      id: EXAMPLE_ID,
      userId: EXAMPLE_USER,
      level: 0,
      orderIndex: 0,
      channelRefs: [EXAMPLE_CHANNEL],
    },
    {
      id: EXAMPLE_TENANT,
      userId: EXAMPLE_MANAGER,
      level: 2,
      orderIndex: 0,
      channelRefs: [EXAMPLE_CHANNEL],
    },
  ],
  schedules: [
    {
      id: EXAMPLE_USER,
      userId: EXAMPLE_USER,
      startsAt: '2026-10-19T07:00:00.000Z',
      endsAt: '2026-10-26T07:00:00.000Z',
    },
  ],
  createdAt: EXAMPLE_AT,
  updatedAt: EXAMPLE_AT,
};

const etagHeader = {
  ETag: {
    description: 'Version of the roster, to send back in If-Match.',
    schema: { type: 'string' },
  },
};

const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

/** The OpenAPI 3.1 document for the on-call roster API, generated from the Zod contracts. */
export function oncallOpenApiDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Blackwing control-plane API: on-call rosters',
      version: '1.0.0',
      description:
        'Who is paged for a Gate 2 exception and in what order (F13, F31). Org Admin only. Rosters are tenant-scoped; edits use ETag/If-Match.',
    },
    paths: {
      [ONCALL_ROSTERS_ROUTE]: {
        get: {
          operationId: 'listOncallRosters',
          summary: 'List the tenant on-call rosters',
          description: 'Requires settings:read (Org Admin).',
          security: SECURITY,
          responses: {
            '200': {
              description: 'The tenant rosters, oldest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items', 'nextCursor'],
                    properties: {
                      items: { type: 'array', items: ROSTER_REF },
                      nextCursor: { type: 'null' },
                    },
                  },
                  examples: { one: { value: { items: [rosterExample], nextCursor: null } } },
                },
              },
            },
            ...errorResponses(ONCALL_READ_ERROR_CODES),
          },
        },
        post: {
          operationId: 'createOncallRoster',
          summary: 'Create an on-call roster',
          description:
            'Requires settings:write (Org Admin). A tenant has at most one active roster. Schedule boundaries without a Z or offset are read in the roster timezone. Audited as oncall.roster.updated.',
          security: SECURITY,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OncallRosterCreate' },
                examples: {
                  rotation: {
                    summary: 'Primary on a weekly rotation, manager as the last resort',
                    value: {
                      name: 'Primary rotation',
                      timezone: 'Europe/Berlin',
                      members: [
                        {
                          userId: EXAMPLE_USER,
                          level: 0,
                          orderIndex: 0,
                          channelRefs: [EXAMPLE_CHANNEL],
                        },
                        {
                          userId: EXAMPLE_MANAGER,
                          level: 2,
                          orderIndex: 0,
                          channelRefs: [EXAMPLE_CHANNEL],
                        },
                      ],
                      schedules: [
                        {
                          userId: EXAMPLE_USER,
                          startsAt: '2026-10-19T09:00',
                          endsAt: '2026-10-26T09:00',
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The roster, with its ETag and Location.',
              headers: { ...etagHeader, Location: { schema: { type: 'string' } } },
              content: {
                'application/json': {
                  schema: ROSTER_REF,
                  examples: { created: { value: rosterExample } },
                },
              },
            },
            ...errorResponses(ONCALL_CREATE_ERROR_CODES),
          },
        },
      },
      [`${ONCALL_ROSTERS_ROUTE}/{id}`]: {
        get: {
          operationId: 'getOncallRoster',
          summary: 'An on-call roster with its members and schedule',
          description: 'Requires settings:read (Org Admin).',
          security: SECURITY,
          parameters: [idParameter],
          responses: {
            '200': {
              description: 'The roster and its ETag.',
              headers: etagHeader,
              content: {
                'application/json': {
                  schema: ROSTER_REF,
                  examples: { roster: { value: rosterExample } },
                },
              },
            },
            ...errorResponses(ONCALL_READ_ERROR_CODES),
          },
        },
        patch: {
          operationId: 'updateOncallRoster',
          summary: 'Change an on-call roster',
          description:
            'Requires settings:write (Org Admin) and the current ETag in If-Match. A members or schedules list replaces the stored list. Audited as oncall.roster.updated.',
          security: SECURITY,
          parameters: [
            idParameter,
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 1 },
              example: '"v0"',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OncallRosterPatch' },
                examples: { rename: { value: { name: 'Night rotation' } } },
              },
            },
          },
          responses: {
            '200': {
              description: 'The updated roster and its new ETag.',
              headers: etagHeader,
              content: {
                'application/json': {
                  schema: ROSTER_REF,
                  examples: { updated: { value: { ...rosterExample, stateVersion: 1 } } },
                },
              },
            },
            ...errorResponses(ONCALL_PATCH_ERROR_CODES),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'bw_pat_ token' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'bw_session' },
      },
      schemas: {
        OncallRoster: jsonSchema(oncallRosterSchema),
        OncallRosterCreate: jsonSchema(oncallRosterCreateSchema),
        OncallRosterPatch: jsonSchema(oncallRosterPatchSchema),
        Problem: jsonSchema(problemSchema),
      },
    },
  };
}
