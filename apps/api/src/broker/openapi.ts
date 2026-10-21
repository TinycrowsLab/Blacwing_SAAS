import { z } from 'zod';

import {
  BROKER_BASE_PATH,
  brokerCandidateRequestSchema,
  brokerEvidenceRequestSchema,
  brokerJournalRequestSchema,
  brokerStateResponseSchema,
} from '@blackwing/contracts';
import { ERROR_CODES, PROBLEM_JSON_CONTENT_TYPE } from '@blackwing/errors';

import {
  BROKER_CANDIDATES_ROUTE,
  BROKER_EVIDENCE_ROUTE,
  BROKER_JOURNAL_ROUTE,
  BROKER_STATE_ROUTE,
} from './routes.js';

type JsonObject = Record<string, unknown>;

const jsonSchema = (schema: z.ZodType): JsonObject => {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'input',
  }) as JsonObject;
  const rest = { ...generated };
  delete rest.$schema;
  return rest;
};

/** Error codes every broker endpoint can answer with. */
const COMMON_CODES = ['UNAUTHENTICATED', 'FORBIDDEN', 'RATE_LIMITED', 'NOT_IMPLEMENTED'] as const;

const toOpenApiPath = (route: string): string => route.replaceAll(/:(\w+)/g, '{$1}');

function responses(extra: readonly (keyof typeof ERROR_CODES)[]): JsonObject {
  const codes = [...COMMON_CODES, ...extra];
  const byStatus = new Map<number, string[]>();
  for (const code of codes) {
    const status = ERROR_CODES[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()].map(([status, list]) => [
      String(status),
      {
        description: `Problem details; code is one of ${list.join(', ')}.`,
        content: {
          [PROBLEM_JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/Problem' } },
        },
      },
    ]),
  );
}

const runIdParameter = {
  name: 'runId',
  in: 'path',
  required: true,
  description: 'Must equal the run id inside the bwrun_ token, otherwise 403.',
  schema: { type: 'string', format: 'uuid' },
};

function writeOperation(
  operationId: string,
  summary: string,
  owner: string,
  schema: z.ZodType,
): JsonObject {
  return {
    post: {
      operationId,
      summary,
      description: `Stub owned by ${owner}: validates the request and answers 501 until implemented.`,
      security: [{ runToken: [] }],
      parameters: [runIdParameter],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: jsonSchema(schema) } },
      },
      responses: responses(['VALIDATION_FAILED', 'RUN_NOT_ACTIVE']),
    },
  };
}

/**
 * OpenAPI 3.1 document of the INTERNAL Run Broker API. It is published to the broker's consumers (tool
 * backends in the sandbox network) only; it is never merged into the public document, whose paths all
 * live under `/v1` (API-014 acceptance: `/internal/broker/*` is absent from the public spec).
 */
export function brokerOpenApiDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Blackwing internal Run Broker API',
      version: '1.0.0',
      description:
        'Reachable only from the sandbox run network with a short-lived run-scoped token (CONTEXT_PACK §4.1, §9). Internal: not part of the public API.',
    },
    paths: {
      [toOpenApiPath(BROKER_CANDIDATES_ROUTE)]: writeOperation(
        'submitCandidate',
        'Submit a finding candidate',
        'FINDING/VALIDATE',
        brokerCandidateRequestSchema,
      ),
      [toOpenApiPath(BROKER_EVIDENCE_ROUTE)]: writeOperation(
        'recordEvidence',
        'Record evidence metadata',
        'EVIDENCE',
        brokerEvidenceRequestSchema,
      ),
      [toOpenApiPath(BROKER_JOURNAL_ROUTE)]: writeOperation(
        'appendJournal',
        'Append a reversal-journal entry',
        'REVERSAL',
        brokerJournalRequestSchema,
      ),
      [toOpenApiPath(BROKER_STATE_ROUTE)]: {
        get: {
          operationId: 'getRunState',
          summary: 'Read the run state',
          description: `Stub owned by ORCH/WORKFLOW; answers 501 until implemented. The eventual 200 body is ${BROKER_BASE_PATH}-internal.`,
          security: [{ runToken: [] }],
          parameters: [runIdParameter],
          responses: {
            ...responses([]),
            '200': {
              description: 'Reserved contract for the implemented endpoint.',
              content: { 'application/json': { schema: jsonSchema(brokerStateResponseSchema) } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        runToken: { type: 'http', scheme: 'bearer', description: 'bwrun_<payload>.<signature>' },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'code', 'traceId'],
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string' },
            traceId: { type: 'string' },
          },
        },
      },
    },
  };
}
