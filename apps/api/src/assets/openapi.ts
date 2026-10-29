import {
  ASSET_ENVIRONMENTS,
  ASSET_TYPES,
  assetListResponseSchema,
  assetViewSchema,
  createAssetBodySchema,
  idempotencyKeySchema,
  listAssetsQuerySchema,
  updateAssetBodySchema,
  VERIFICATION_STATUSES,
} from '@blackwing/contracts';

import { errorResponses, type JsonObject, jsonSchema, registerSchema } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** The wizard projection of one asset, as the list answers it (no identifiers, credentials or attestations). */
const EXAMPLE_LIST_ITEM = {
  id: '0198f0a0-0000-7000-8000-0000000000e1',
  name: 'Juice Shop (lab)',
  type: 'web_app',
  environment: 'dev',
  verificationStatus: 'verified',
};

/** Error codes a request to one asset route can answer with, by route. */
const ASSET_COLLECTION_ERROR_CODES = [
  'UNAUTHENTICATED',
  'TENANT_CONTEXT_MISSING',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_MISMATCH',
  'ASSET_INVALID_IDENTIFIER',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];
const ASSET_ITEM_ERROR_CODES = [
  'UNAUTHENTICATED',
  'TENANT_CONTEXT_MISSING',
  'FORBIDDEN',
  'NOT_FOUND',
  'PRECONDITION_REQUIRED',
  'ASSET_STALE_WRITE',
  'ASSET_IN_USE',
  'VALIDATION_FAILED',
  'ASSET_INVALID_IDENTIFIER',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

const ASSET_ID = 'asset_0r3h7k4xw0c8g1n5p2q6v9m3yt';
const OWNER = '0198f0a0-0000-7000-8000-00000000000a';
const WHEN = '2026-10-30T10:00:00.000Z';
const ETAG = '"v1"';
/** Every asset route takes a session cookie or a bearer token (§9), the same as the kill routes. */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Public asset id (`asset_…`).',
  schema: { type: 'string', pattern: '^asset_[0-9a-hjkmnp-tv-z]{26}$' },
};
const ifMatchParameter = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description:
    'The ETag from the last GET (or the write that produced the current version). Required; a stale value answers 409 `ASSET_STALE_WRITE`.',
  schema: { type: 'string', example: ETAG },
};
const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Optional. A replay with the same key and body returns the asset the first request created (200); the same key with a different body answers 422.',
  schema: jsonSchema(idempotencyKeySchema),
};

const exampleView = {
  id: '0198f0a0-0000-7000-8000-0000000000e1',
  publicId: ASSET_ID,
  type: 'web_app',
  name: 'Customer portal',
  identifiers: [{ kind: 'url', value: 'https://portal.example.com/' }],
  environment: 'staging',
  ownerUserId: OWNER,
  verificationStatus: 'unverified',
  verificationMethod: null,
  etag: ETAG,
  createdAt: WHEN,
  updatedAt: WHEN,
  warnings: [],
};

function jsonContent(schemaRef: string, example?: unknown): JsonObject {
  return {
    'application/json': {
      schema: { $ref: `#/components/schemas/${schemaRef}` },
      ...(example === undefined ? {} : { example }),
    },
  };
}

/** The asset REST API as a module of the public document (ASSET-002). */
export function assetOpenApiModule(): {
  readonly tag: string;
  readonly description: string;
  readonly paths: JsonObject;
  readonly schemas: JsonObject;
} {
  const schemas: JsonObject = {};
  registerSchema(schemas, 'AssetView', assetViewSchema);
  registerSchema(schemas, 'CreateAssetBody', createAssetBodySchema);
  registerSchema(schemas, 'UpdateAssetBody', updateAssetBodySchema);
  registerSchema(schemas, 'AssetPage', assetListResponseSchema);
  registerSchema(schemas, 'AssetListQuery', listAssetsQuerySchema);

  const paths: JsonObject = {
    '/v1/assets': {
      post: {
        operationId: 'createAsset',
        tags: ['assets'],
        security: SECURITY,
        summary: 'Register an asset',
        description:
          'Creates an asset in the caller’s tenant, owned by `ownerUserId` (who must be a member). Identifiers are normalised; the asset starts `unverified` and cannot be targeted until verified (§8.10).',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: jsonContent('CreateAssetBody', {
            type: 'web_app',
            name: 'Customer portal',
            identifiers: [{ kind: 'url', value: 'https://portal.example.com' }],
            environment: 'staging',
            ownerUserId: OWNER,
          }),
        },
        responses: {
          '201': {
            description: 'Created. The `ETag` header carries the asset version.',
            headers: {
              ETag: { schema: { type: 'string' } },
              Location: { schema: { type: 'string' } },
            },
            content: jsonContent('AssetView', exampleView),
          },
          '200': {
            description:
              'Replay of an earlier create with the same `Idempotency-Key`: the same asset.',
            content: jsonContent('AssetView', exampleView),
          },
          ...errorResponses(ASSET_COLLECTION_ERROR_CODES),
        },
      },
      get: {
        operationId: 'listAssets',
        tags: ['assets'],
        security: SECURITY,
        summary: 'List assets (cursor pages, newest first)',
        parameters: [
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 200 },
          },
          {
            name: 'type',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: [...ASSET_TYPES] },
          },
          {
            name: 'environment',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: [...ASSET_ENVIRONMENTS] },
          },
          {
            name: 'verificationStatus',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: [...VERIFICATION_STATUSES] },
          },
        ],
        responses: {
          '200': {
            description:
              'One page of the projection (the scoping wizard fields). `nextCursor` is null on the last page. Each item’s `id` is the UUID; the full view is on `GET /v1/assets/{id}`.',
            headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } },
            content: jsonContent('AssetPage', {
              items: [EXAMPLE_LIST_ITEM],
              nextCursor: null,
              hasMore: false,
            }),
          },
          ...errorResponses(ASSET_COLLECTION_ERROR_CODES),
        },
      },
    },
    '/v1/assets/{id}': {
      get: {
        operationId: 'getAsset',
        tags: ['assets'],
        security: SECURITY,
        summary: 'Get one asset',
        description:
          'A soft-deleted asset is `404`, as is an id of another tenant (never `403`, §8.6).',
        parameters: [idParameter],
        responses: {
          '200': {
            description: 'The asset. The `ETag` header is the value to send back in `If-Match`.',
            headers: { ETag: { schema: { type: 'string' } } },
            content: jsonContent('AssetView', exampleView),
          },
          ...errorResponses(ASSET_ITEM_ERROR_CODES),
        },
      },
      patch: {
        operationId: 'updateAsset',
        tags: ['assets'],
        security: SECURITY,
        summary: 'Update an asset (optimistic concurrency)',
        parameters: [idParameter, ifMatchParameter],
        requestBody: {
          required: true,
          content: jsonContent('UpdateAssetBody', { name: 'Customer portal (EU)' }),
        },
        responses: {
          '200': {
            description: 'Updated. The `ETag` header carries the new version.',
            headers: { ETag: { schema: { type: 'string' } } },
            content: jsonContent('AssetView', exampleView),
          },
          ...errorResponses(ASSET_ITEM_ERROR_CODES),
        },
      },
      delete: {
        operationId: 'deleteAsset',
        tags: ['assets'],
        security: SECURITY,
        summary: 'Soft-delete an asset',
        description:
          'The row is kept (audit history); the asset disappears from GET and list. Answers the retired asset. Refused with `409 ASSET_IN_USE` while an active or pending standing authorisation covers it.',
        parameters: [
          idParameter,
          {
            ...ifMatchParameter,
            required: false,
            description: 'Optional. When present, must match the current ETag.',
          },
        ],
        responses: {
          '200': {
            description:
              'Deleted. The body is the retired asset; the `ETag` header is its final version.',
            headers: { ETag: { schema: { type: 'string' } } },
            content: jsonContent('AssetView', exampleView),
          },
          ...errorResponses(ASSET_ITEM_ERROR_CODES),
        },
      },
    },
  };
  return {
    tag: 'assets',
    description: 'Asset registry: register, read, list, update and retire assets.',
    paths,
    schemas,
  };
}
