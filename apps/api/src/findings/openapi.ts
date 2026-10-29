import {
  findingDetailSchema,
  findingListResponseSchema,
  findingSummarySchema,
} from '@blackwing/contracts';

import { type JsonObject, type OpenApiModule, jsonSchema } from '../openapi/schema.js';

const COLLECTION = '/v1/findings';
const ITEM = `${COLLECTION}/{id}`;

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const ID_PARAMETER: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The `fnd_…` public id of the finding.',
  schema: { type: 'string', pattern: '^fnd_[A-Za-z0-9]+$' },
};

const problem = (description: string): JsonObject => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const EXAMPLE_FINDING = {
  id: 'fnd_01m64cavacexhrddgjb6xd80xv',
  title: 'Missing authorisation on /admin',
  class: 'broken_access_control',
  status: 'confirmed',
  baselineStatus: 'new',
  severity: null,
  cweId: 'CWE-285',
  owaspCategory: 'A01',
  unmapped: false,
  confidence: 0.9,
  assetId: '0198f0a0-0000-7000-8000-0000000000e1',
  location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
  firstSeenRunId: '0198f0a0-0000-7000-8000-0000000000c1',
  lastSeenRunId: '0198f0a0-0000-7000-8000-0000000000c1',
  stateVersion: 1,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:05:00.000Z',
};

const EXAMPLE_DETAIL = {
  ...EXAMPLE_FINDING,
  mappingVersion: '1.0.0',
  classification: { cweCandidates: ['CWE-285'], apiTop10: 'API1', wstg: ['WSTG-ATHZ-02'] },
  acceptedRisk: null,
  releasedBy: null,
  releasedAt: null,
  occurrences: {
    items: [
      {
        id: '0198f0a0-0000-7000-8000-0000000000c2',
        runId: '0198f0a0-0000-7000-8000-0000000000c1',
        occurrenceStatus: 'observed',
        evidenceChainHead: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        detectedAt: '2026-10-29T10:00:00.000Z',
      },
    ],
    total: 1,
    truncated: false,
  },
  evidence: {
    items: [
      {
        evidenceId: '0198f0a0-0000-7000-8000-0000000000c3',
        objectKey: 'evidence/run-c1/request-0001.bin',
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        chain: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        occurrenceId: '0198f0a0-0000-7000-8000-0000000000c2',
        runId: '0198f0a0-0000-7000-8000-0000000000c1',
      },
    ],
    total: 1,
    truncated: false,
  },
};

/** Findings (FINDING query API): a filtered, cursor-paginated list and one finding's detail. Read-only. */
export function findingOpenApiModule(): OpenApiModule {
  return {
    tag: 'findings',
    description:
      'Findings: list and detail, tenant-scoped and read-only. Suspected findings are visible to analysts only (F17).',
    paths: {
      [COLLECTION]: {
        get: {
          operationId: 'listFindings',
          tags: ['findings'],
          summary: 'List the findings of the tenant, newest first',
          description:
            'Needs finding:read. Filters combine with AND. An unknown filter, a CWE or OWASP id outside the pinned lists, or a malformed limit is 400. Suspected findings are excluded unless the caller is an analyst. The page size is clamped to 200.',
          security: SECURITY,
          parameters: [
            {
              name: 'assetId',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'uuid' },
            },
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'severity',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] },
            },
            {
              name: 'cwe',
              in: 'query',
              required: false,
              schema: { type: 'string', pattern: '^CWE-[1-9][0-9]{0,4}$' },
            },
            {
              name: 'owasp',
              in: 'query',
              required: false,
              schema: { type: 'string', pattern: '^A(0[1-9]|10)$' },
            },
            { name: 'baselineStatus', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 2048 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of findings.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/FindingList' },
                  examples: {
                    current: {
                      summary: 'One finding',
                      value: { items: [EXAMPLE_FINDING], nextCursor: null, hasMore: false },
                    },
                  },
                },
              },
            },
            '400': problem(
              'A malformed cursor (invalid_cursor), limit (bad_request) or filter (invalid_filter).',
            ),
            '401': problem('No valid credential.'),
            '403': problem('The caller has no finding:read permission in this tenant.'),
          },
        },
      },
      [ITEM]: {
        get: {
          operationId: 'getFinding',
          tags: ['findings'],
          summary: 'Get one finding with its occurrences, mapping and evidence refs',
          description:
            'Needs finding:read. Occurrences and evidence refs are each capped at 50 and carry total and truncated. Evidence is referenced by its chain head and resolved by the evidence API. A finding the caller may not see is 404.',
          security: SECURITY,
          parameters: [ID_PARAMETER],
          responses: {
            '200': {
              description: 'The finding detail.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Finding' },
                  examples: {
                    current: {
                      summary: 'A confirmed finding with one occurrence',
                      value: EXAMPLE_DETAIL,
                    },
                  },
                },
              },
            },
            '401': problem('No valid credential.'),
            '403': problem('The caller has no finding:read permission in this tenant.'),
            '404': problem('Unknown, foreign or hidden finding.'),
          },
        },
      },
    },
    schemas: {
      Finding: jsonSchema(findingDetailSchema),
      FindingSummary: jsonSchema(findingSummarySchema),
      FindingList: jsonSchema(findingListResponseSchema),
    },
  };
}
