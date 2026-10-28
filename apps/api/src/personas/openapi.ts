import { PERSONA_NAMES, personaOverrideSchema } from '@blackwing/agents';

import { PERSONA_OVERRIDE_ROUTE } from './routes.js';
import {
  errorResponses,
  type JsonObject,
  jsonSchema,
  type OpenApiModule,
} from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** Error codes `GET /v1/personas/{persona}/override` can answer with. */
export const PERSONA_GET_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'PERSONA_UNKNOWN',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Error codes `PUT /v1/personas/{persona}/override` can answer with. */
export const PERSONA_PUT_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'PERSONA_UNKNOWN',
  'OVERRIDE_FIELD_FORBIDDEN',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_AT = '2026-10-20T10:00:00.000Z';

/** The persona override module of the public document (REGISTRY-010). */
export function personaOpenApiModule(): OpenApiModule {
  const personaParameter = {
    name: 'persona',
    in: 'path',
    required: true,
    description: 'A persona of the fixed roster.',
    schema: { type: 'string', enum: [...PERSONA_NAMES] },
  };
  const security = [{ bearerAuth: [] }, { sessionCookie: [] }];
  const responseSchema = { $ref: '#/components/schemas/PersonaOverrideView' };
  const example = {
    persona: 'osint',
    override: { effort: 'low', maxTurns: 10 },
    updatedAt: EXAMPLE_AT,
  };

  const paths: JsonObject = {
    [PERSONA_OVERRIDE_ROUTE.replace(':persona', '{persona}')]: {
      get: {
        operationId: 'getPersonaOverride',
        summary: 'The tenant override of a persona',
        description:
          'Requires settings:read. Answers the override the tenant set, or null when none is set (the base values apply).',
        security,
        parameters: [personaParameter],
        responses: {
          '200': {
            description: 'The persona override view.',
            content: {
              'application/json': { schema: responseSchema, examples: { set: { value: example } } },
            },
          },
          ...errorResponses(PERSONA_GET_ERROR_CODES),
        },
      },
      put: {
        operationId: 'putPersonaOverride',
        summary: 'Replace the tenant override of a persona',
        description:
          'Requires settings:write (org_admin). The body replaces the whole override; an empty object resets the persona to its base values. Only effort, maxTurns, maxBudgetUsd and lowerStandardTier are accepted: any other field answers OVERRIDE_FIELD_FORBIDDEN. Values above the persona bounds are clamped, never raised. The change is audited as persona.override_changed.',
        security,
        parameters: [personaParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PersonaOverride' },
              examples: {
                tighten: { summary: 'Shorter run', value: { effort: 'low', maxTurns: 10 } },
                reset: { summary: 'Use the base values', value: {} },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The override as stored.',
            content: {
              'application/json': { schema: responseSchema, examples: { set: { value: example } } },
            },
          },
          ...errorResponses(PERSONA_PUT_ERROR_CODES),
        },
      },
    },
  };

  return {
    tag: 'personas',
    description:
      'Tenant overrides of a persona: effort, turn and spend budgets, and standard-tier lowering.',
    paths,
    schemas: {
      PersonaOverride: jsonSchema(personaOverrideSchema),
      PersonaOverrideView: {
        type: 'object',
        additionalProperties: false,
        required: ['persona', 'override', 'updatedAt'],
        properties: {
          persona: { type: 'string', enum: [...PERSONA_NAMES] },
          override: {
            anyOf: [{ $ref: '#/components/schemas/PersonaOverride' }, { type: 'null' }],
          },
          updatedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  };
}
