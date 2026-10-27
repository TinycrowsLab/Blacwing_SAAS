import { auditActionSchema, auditOutcomeSchema } from '@blackwing/contracts';

import { AUDIT_QUERY_LIMIT_DEFAULT, AUDIT_QUERY_LIMIT_MAX } from './query.js';
import { AUDIT_EVENTS_ROUTE } from './routes.js';
import { errorResponses, type JsonObject, jsonSchema } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** Error codes `GET /v1/audit/events` can answer with, by status. */
export const AUDIT_EVENTS_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'VALIDATION_FAILED',
  'INVALID_CURSOR',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const EXAMPLE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const EXAMPLE_RUN = '01890a5d-ac96-774b-bcce-b302099a8058';
const EXAMPLE_AT = '2026-10-20T10:00:00.000Z';

/** One ledger row as the API returns it (see `AuditEventView` in `service.ts`). */
function auditEventViewSchema(): JsonObject {
  return {
    type: 'object',
    required: [
      'id',
      'seq',
      'occurredAt',
      'action',
      'severity',
      'actor',
      'target',
      'outcome',
      'reason',
      'metadata',
      'traceId',
      'runId',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string', format: 'uuid' },
      seq: { type: 'integer', minimum: 1 },
      occurredAt: { type: 'string', format: 'date-time' },
      action: { ...jsonSchema(auditActionSchema) },
      severity: { type: 'string', enum: ['info', 'notice', 'warning', 'critical'] },
      actor: {
        type: 'object',
        description: 'Who acted. `email` is only returned to auditors.',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['user', 'operator', 'service', 'system', 'anonymous'] },
          id: { type: 'string' },
          email: { type: 'string' },
          tokenId: { type: 'string' },
        },
      },
      target: {
        type: 'object',
        required: ['type', 'id'],
        properties: {
          type: { type: 'string' },
          id: { type: 'string' },
          publicId: { type: 'string' },
        },
      },
      outcome: { ...jsonSchema(auditOutcomeSchema) },
      reason: { type: ['string', 'null'] },
      metadata: { type: 'object', description: 'Empty for callers that are not auditors.' },
      metadataRef: { type: 'object', description: 'Only returned to auditors.' },
      traceId: { type: ['string', 'null'] },
      runId: { type: ['string', 'null'], format: 'uuid' },
      hash: { type: 'string', description: 'Hex SHA-256 chain hash. Only with includeChain=true.' },
      prevHash: {
        type: ['string', 'null'],
        description: 'Hex previous hash; null on the genesis row. Only with includeChain=true.',
      },
    },
  };
}

/** The OpenAPI fragment `audit` contributes to the public document (#86). */
export function auditOpenApiPaths(): JsonObject {
  return {
    [AUDIT_EVENTS_ROUTE]: {
      get: {
        operationId: 'listAuditEvents',
        summary: 'Search the audit ledger of the caller tenant',
        description:
          'Requires audit:read (auditor, org_admin). Newest first, by (occurredAt, seq). The tenant comes from the caller, never from the query. `from` and `to` are ISO-8601 UTC with a Z. Pass the previous nextCursor to continue; a cursor is bound to its filters. The query itself is recorded as audit.queried. includeChain=true needs the auditor role.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        parameters: [
          {
            name: 'actorId',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 255 },
            example: 'usr_01jabc',
          },
          {
            name: 'action',
            in: 'query',
            required: false,
            schema: jsonSchema(auditActionSchema),
            example: 'kill.fired',
          },
          {
            name: 'targetId',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 255 },
            example: EXAMPLE_RUN,
          },
          {
            name: 'runId',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'uuid' },
            example: EXAMPLE_RUN,
          },
          {
            name: 'outcome',
            in: 'query',
            required: false,
            schema: jsonSchema(auditOutcomeSchema),
            example: 'success',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            example: '2026-10-01T00:00:00Z',
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            example: '2026-10-31T23:59:59Z',
          },
          {
            name: 'includeChain',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false'] },
            description: 'Auditors only: include hash and prevHash.',
          },
          {
            name: 'cursor',
            in: 'query',
            required: false,
            schema: { type: 'string', minLength: 1 },
            example: 'eyJrIjpbIjIwMjYtMTAtMjBUMTA6MDA6MDAuMDAwWiIsNDJdfQ.c2ln',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              maximum: AUDIT_QUERY_LIMIT_MAX,
              default: AUDIT_QUERY_LIMIT_DEFAULT,
            },
            example: 50,
          },
        ],
        responses: {
          '200': {
            description: 'One page of events, newest first. nextCursor is absent on the last page.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      maxItems: AUDIT_QUERY_LIMIT_MAX,
                      items: { $ref: '#/components/schemas/AuditEventView' },
                    },
                    nextCursor: { type: 'string' },
                  },
                },
                examples: {
                  page: {
                    summary: 'A page with a next cursor',
                    value: {
                      items: [
                        {
                          id: EXAMPLE_ID,
                          seq: 42,
                          occurredAt: EXAMPLE_AT,
                          action: 'kill.fired',
                          severity: 'critical',
                          actor: { type: 'user', id: 'usr_01jabc' },
                          target: { type: 'run', id: EXAMPLE_RUN },
                          outcome: 'success',
                          reason: 'unexpected 5xx spike',
                          metadata: { scope: 'run' },
                          traceId: null,
                          runId: EXAMPLE_RUN,
                        },
                      ],
                      nextCursor: 'eyJrIjpbIjIwMjYtMTAtMjBUMTA6MDA6MDAuMDAwWiIsNDJdfQ.c2ln',
                    },
                  },
                },
              },
            },
          },
          ...errorResponses(AUDIT_EVENTS_ERROR_CODES),
        },
      },
    },
  };
}

/** The schemas the audit paths reference, for `components.schemas` (the shared `Problem` is added by the builder). */
export function auditOpenApiSchemas(): JsonObject {
  return { AuditEventView: auditEventViewSchema() };
}
