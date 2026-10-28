import { z } from 'zod';

import {
  EFFORT_LEVELS,
  ORACLE_CATALOGUE,
  PERSONA_INTRUSIVENESS_CEILINGS,
  PERSONA_NAMES,
  PERSONA_OVERRIDE_FIELDS,
  personaOverrideSchema,
  TIER_ALIASES,
} from '@blackwing/agents';

import { PERSONA_COLLECTION_ROUTE, PERSONA_ITEM_ROUTE, PERSONA_OVERRIDE_ROUTE } from './routes.js';
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

/** Error codes `GET /v1/personas` can answer with (REGISTRY-011). */
export const PERSONA_REGISTRY_LIST_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** Error codes `GET /v1/personas/{persona}` can answer with (REGISTRY-011). */
export const PERSONA_REGISTRY_GET_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'PERSONA_UNKNOWN',
  'PERSONA_NOT_DEFINED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_AT = '2026-10-20T10:00:00.000Z';

const TOOL_NAMES = z.array(z.string().min(1));

/**
 * One persona of the registry as `GET /v1/personas` serves it (REGISTRY-011). An explicit allowlist: the guardrail
 * flags, the structured-output schema id and the prompt reference stay internal and are not published.
 */
const personaRegistryViewSchema = z.strictObject({
  name: z.enum(PERSONA_NAMES),
  mandate: z.string().min(1),
  promptVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  tierAlias: z.enum(TIER_ALIASES),
  effective: z.strictObject({
    model: z.string().min(1),
    effort: z.enum(EFFORT_LEVELS),
    maxTurns: z.number().int().min(1),
    maxBudgetUsd: z.number().positive(),
  }),
  overridden: z.array(z.enum(PERSONA_OVERRIDE_FIELDS)),
  allowedTools: TOOL_NAMES,
  disallowedTools: TOOL_NAMES,
  declaredOracleTypes: z.array(z.enum(ORACLE_CATALOGUE)),
  inputs: z.array(z.string().min(1)),
  intrusivenessCeiling: z.enum(PERSONA_INTRUSIVENESS_CEILINGS),
  requiresSubmission: z.boolean(),
  helpers: z.array(
    z.strictObject({
      name: z.string().min(1),
      description: z.string().min(1),
      tierAlias: z.enum(TIER_ALIASES),
      allowedTools: TOOL_NAMES,
    }),
  ),
});

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

  const registryExample = {
    name: 'osint',
    mandate: 'Gather public information about approved assets.',
    promptVersion: '1.0.0',
    tierAlias: 'standard',
    effective: { model: 'claude-opus-5-5', effort: 'low', maxTurns: 10, maxBudgetUsd: 2 },
    overridden: ['effort', 'maxTurns'],
    allowedTools: ['Read'],
    disallowedTools: ['WebFetch', 'WebSearch'],
    declaredOracleTypes: [],
    inputs: ['scope'],
    intrusivenessCeiling: 'passive',
    requiresSubmission: false,
    helpers: [],
  };
  const registryResponse = (schemaName: string, example: unknown) => ({
    description: `The ${schemaName} view.`,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaName}` },
        examples: { set: { value: example } },
      },
    },
  });

  const paths: JsonObject = {
    [PERSONA_COLLECTION_ROUTE]: {
      get: {
        operationId: 'listPersonas',
        summary: 'The persona registry for the caller tenant',
        description:
          'Requires run:read, which every tenant role holds. Lists the fixed roster of personas in roster order, each with the settings a run of the caller tenant would pin (the tenant override merged in). Guardrail flags and internal fields are not published.',
        security,
        responses: {
          '200': registryResponse('PersonaRegistryList', { items: [registryExample] }),
          ...errorResponses(PERSONA_REGISTRY_LIST_ERROR_CODES),
        },
      },
    },
    [PERSONA_ITEM_ROUTE.replace(':persona', '{persona}')]: {
      get: {
        operationId: 'getPersona',
        summary: 'One persona of the registry for the caller tenant',
        description:
          'Requires run:read. The same view as the list, for one persona of the fixed roster.',
        security,
        parameters: [personaParameter],
        responses: {
          '200': registryResponse('PersonaRegistryView', registryExample),
          ...errorResponses(PERSONA_REGISTRY_GET_ERROR_CODES),
        },
      },
    },
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
      'The persona registry (definitions with the tenant effective settings) and tenant overrides of a persona: effort, turn and spend budgets, and standard-tier lowering.',
    paths,
    schemas: {
      PersonaOverride: jsonSchema(personaOverrideSchema),
      PersonaRegistryView: jsonSchema(personaRegistryViewSchema),
      PersonaRegistryList: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/PersonaRegistryView' } },
        },
      },
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
