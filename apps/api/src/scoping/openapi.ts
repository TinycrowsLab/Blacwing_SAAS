import {
  createInputManifestUploadSchema,
  inputManifestSpecObjectSchema,
  inputManifestUploadGrantSchema,
  inputManifestUploadRemovedSchema,
} from '@blackwing/contracts';

import { type JsonObject, type OpenApiModule, jsonSchema } from '../openapi/schema.js';

const UPLOADS = '/v1/input-manifests/{id}/uploads';
const UPLOAD = `${UPLOADS}/{uploadId}`;

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const MANIFEST_ID: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The uuid of the input manifest, in the caller tenant.',
  schema: { type: 'string', format: 'uuid' },
};

const UPLOAD_ID: JsonObject = {
  name: 'uploadId',
  in: 'path',
  required: true,
  description: 'The uuid of the upload, from the grant.',
  schema: { type: 'string', format: 'uuid' },
};

const EXAMPLE_UPLOAD_ID = '0198f0a0-0000-7000-8000-000000000101';
const EXAMPLE_DECLARATION = {
  kind: 'openapi',
  filename: 'payments-api.json',
  contentType: 'application/json',
  sizeBytes: 48213,
};
const EXAMPLE_GRANT = {
  uploadId: EXAMPLE_UPLOAD_ID,
  kind: 'openapi',
  objectKey: `inputs/0198f0a0-0000-7000-8000-00000000000a/0198f0a0-0000-7000-8000-0000000000c1/${EXAMPLE_UPLOAD_ID}-payments-api.json`,
  method: 'POST',
  url: 'https://storage.example.test/blackwing-inputs',
  fields: {
    key: 'inputs/…/payments-api.json',
    'Content-Type': 'application/json',
    policy: '…',
    signature: '…',
  },
  expiresAt: '2026-10-30T10:05:00.000Z',
};
const EXAMPLE_OBJECT = {
  uploadId: EXAMPLE_UPLOAD_ID,
  kind: 'openapi',
  objectKey: EXAMPLE_GRANT.objectKey,
  sha256: 'a3f1c2e4b5d6a7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
  sizeBytes: 48213,
  contentType: 'application/json',
  status: 'uploaded_pending_scan',
};

const problem = (description: string): JsonObject => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

/**
 * Input-manifest uploads (SCOPE-006). A grant is a presigned POST: the client posts `multipart/form-data` to `url`
 * with every field of `fields`, then the file as the last field. `complete` registers the object after the store
 * reports its size, type and bytes; until SCOPE-009 scans it, the object is `uploaded_pending_scan` and INGEST does
 * not read it.
 */
export function inputManifestOpenApiModule(): OpenApiModule {
  return {
    tag: 'input-manifests',
    description:
      'Input manifest uploads: presigned POST grants for API specs, Postman collections, GraphQL schemas, HAR captures and config manifests. Uploads are untrusted and stay pending scan until cleared.',
    paths: {
      [UPLOADS]: {
        post: {
          operationId: 'createInputManifestUpload',
          tags: ['input-manifests'],
          summary: 'Grant a presigned upload for one input manifest object',
          description:
            'Needs assessment:create. The grant binds the exact content type and kind, and a Content-Length range up to the declared size. The size limit and the object count per manifest are server settings.',
          security: SECURITY,
          parameters: [MANIFEST_ID],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InputManifestUploadCreate' },
                examples: {
                  openapi: { summary: 'An OpenAPI document', value: EXAMPLE_DECLARATION },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The grant: post the form to url with its fields.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InputManifestUploadGrant' },
                  examples: { grant: { summary: 'A presigned POST grant', value: EXAMPLE_GRANT } },
                },
              },
            },
            '404': problem('The manifest is not in this tenant (not_found).'),
            '409': problem(
              'The manifest holds the maximum number of objects (scope_manifest_full).',
            ),
            '413': problem('The declared size is over the limit (scope_upload_too_large).'),
            '422': problem('Body validation failed, or the upload is empty (scope_empty_upload).'),
          },
        },
      },
      [`${UPLOAD}/complete`]: {
        post: {
          operationId: 'completeInputManifestUpload',
          tags: ['input-manifests'],
          summary: 'Register an uploaded object as pending scan',
          description:
            'Needs assessment:create. Reads size, type and sha256 from the store, never from the client. Idempotent: a replay answers the same object. An object whose bytes match one already registered answers that object.',
          security: SECURITY,
          parameters: [MANIFEST_ID, UPLOAD_ID],
          responses: {
            '200': {
              description: 'The registered object.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InputManifestSpecObject' },
                  examples: { registered: { summary: 'Pending scan', value: EXAMPLE_OBJECT } },
                },
              },
            },
            '404': problem('The manifest or upload is not in this tenant (not_found).'),
            '409': problem('The object is not in the store (scope_object_missing).'),
            '413': problem('The stored object is over the size limit (scope_upload_too_large).'),
            '415': problem(
              'The stored type is not allowed for the kind (scope_upload_type_not_allowed).',
            ),
            '422': problem('The stored object is empty (scope_empty_upload).'),
          },
        },
      },
      [UPLOAD]: {
        delete: {
          operationId: 'deleteInputManifestUpload',
          tags: ['input-manifests'],
          summary: 'Remove an upload that is still pending scan',
          description:
            'Needs assessment:create. Removes the stored object and its registration. An upload that a scan has cleared can no longer be removed; Object Lock retention still applies to retained versions.',
          security: SECURITY,
          parameters: [MANIFEST_ID, UPLOAD_ID],
          responses: {
            '200': {
              description: 'The upload was removed; the object is gone from the store.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InputManifestUploadRemoved' },
                  examples: {
                    removed: {
                      summary: 'A pending upload was removed',
                      value: { uploadId: EXAMPLE_UPLOAD_ID, status: 'removed' },
                    },
                  },
                },
              },
            },
            '404': problem('The manifest or upload is not in this tenant (not_found).'),
            '409': problem(
              'The upload has been scanned and is no longer pending (scope_upload_not_pending).',
            ),
          },
        },
      },
    },
    schemas: {
      InputManifestUploadCreate: jsonSchema(createInputManifestUploadSchema),
      InputManifestUploadGrant: jsonSchema(inputManifestUploadGrantSchema),
      InputManifestSpecObject: jsonSchema(inputManifestSpecObjectSchema),
      InputManifestUploadRemoved: jsonSchema(inputManifestUploadRemovedSchema),
    },
  };
}
