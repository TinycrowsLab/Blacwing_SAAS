import { surfaceRunViewSchema } from '@blackwing/contracts';

import { RUN_SURFACE_ROUTE } from './routes.js';
import {
  errorResponses,
  type JsonObject,
  type OpenApiModule,
  registerSchema,
} from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** Error codes `GET /v1/runs/{runId}/surface` can answer with. */
export const RUN_SURFACE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_CONTEXT_MISSING',
  'VALIDATION_FAILED',
  'INVALID_QUERY',
  'INVALID_CURSOR',
  'RUN_NOT_FOUND',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const OPENAPI_PATH = RUN_SURFACE_ROUTE.replace(':runId', '{runId}');

/** The run surface view as a module of the public document (GRAPH-006). The schema is generated from the Zod contract. */
export function surfaceOpenApiModule(): OpenApiModule {
  const schemas: JsonObject = {};
  registerSchema(schemas, 'SurfaceRunView', surfaceRunViewSchema);
  return {
    tag: 'surface',
    description: 'Run surface graph for the console view, bounded and paginated.',
    schemas,
    paths: {
      [OPENAPI_PATH]: {
        get: {
          operationId: 'getRunSurface',
          summary: 'Get the bounded surface graph of one run (nodes and edges)',
          description: [
            'Requires run:read in the caller tenant and the Cedar surface policy (an asset owner reads only the runs of assets they own).',
            'A run outside the caller tenant, or an unknown run, answers 404 RUN_NOT_FOUND (uniform, no existence oracle).',
            'Nodes are ranked by degree then confidence and capped at GRAPH_VIZ_MAX_NODES (2000); edges at GRAPH_VIZ_MAX_EDGES (4000). A surface above a cap answers truncated: true with full totals.',
            'Pages are ordered by natural key: pass pageInfo.endCursor back as cursor while hasNextPage is true. Every returned edge joins two nodes of the same page.',
            'A finished run (killed or completed) stays viewable: runState carries its state. The read is audited as run.surface.viewed.',
          ].join(' '),
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'runId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
              example: '01890a5d-ac96-774b-bcce-b302099a8058',
            },
            {
              name: 'kinds',
              in: 'query',
              required: false,
              description:
                'Comma-separated node kinds to keep (asset, host, service, technology, endpoint, parameter, role).',
              schema: { type: 'string', maxLength: 200 },
              example: 'host,service',
            },
            {
              name: 'minConfidence',
              in: 'query',
              required: false,
              description:
                'Keep nodes and edges with provenance confidence at least this (0 to 1).',
              schema: { type: 'number', minimum: 0, maximum: 1, default: 0 },
            },
            {
              name: 'inScopeOnly',
              in: 'query',
              required: false,
              description:
                'true keeps only nodes not marked out of scope (hosts with inScope false are dropped). The graph applies it, so truncation and totals reflect the filter.',
              schema: { type: 'string', enum: ['true', 'false'], default: 'false' },
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              description: 'Opaque cursor: the pageInfo.endCursor of the previous page.',
              schema: { type: 'string', maxLength: 2048 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description:
                'Nodes per page, 1 to 200. Larger or non-numeric values answer 400 INVALID_QUERY.',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
            },
          ],
          responses: {
            '200': {
              description: 'The view of one page of the run surface.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SurfaceRunView' },
                  example: {
                    nodes: [
                      {
                        id: 'host:018f2a6e-1c00-7000-8000-00000000000a:api.example.test',
                        kind: 'host',
                        label: 'api.example.test',
                        inScope: true,
                        confidence: 0.9,
                        degree: 1,
                        provenance: {
                          runId: '01890a5d-ac96-774b-bcce-b302099a8058',
                          tool: 'nmap',
                          firstSeenAt: '2026-10-29T10:00:00.000Z',
                          lastSeenAt: '2026-10-29T10:05:00.000Z',
                        },
                      },
                    ],
                    edges: [],
                    totals: { nodes: 1, edges: 0 },
                    truncated: false,
                    pageInfo: { hasNextPage: false },
                    clusteredBy: 'asset',
                    runState: 'recon',
                  },
                },
              },
            },
            ...errorResponses(RUN_SURFACE_ERROR_CODES),
          },
        },
      },
    },
  };
}
