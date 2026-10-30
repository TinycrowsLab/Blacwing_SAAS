import { z } from 'zod';

/**
 * Wire contracts of the input-manifest upload API (SCOPE-006, CONTEXT_PACK §4.5, §8.6, §8.8). The customer's
 * artefacts are untrusted data: an upload is quarantined (`uploaded_pending_scan`) until SCOPE-009 marks it
 * clean, and the server never trusts a client-declared size or type once the bytes are in the store.
 */

/** The artefact kinds a scoping user may upload (`scope.kind` of an input manifest object). */
export const INPUT_MANIFEST_UPLOAD_KINDS = [
  'openapi',
  'postman',
  'graphql',
  'har',
  'config',
] as const;
export type InputManifestUploadKind = (typeof INPUT_MANIFEST_UPLOAD_KINDS)[number];
export const inputManifestUploadKindSchema = z.enum(INPUT_MANIFEST_UPLOAD_KINDS);

const JSON_TYPES = ['application/json'] as const;
const YAML_TYPES = ['application/yaml', 'text/yaml', 'application/x-yaml'] as const;

/**
 * The media types each kind may carry. The grant's policy and `complete` both check against this list, so a
 * type outside it is refused whether the client declares it or the store reports it.
 */
export const INPUT_MANIFEST_CONTENT_TYPES: Readonly<
  Record<InputManifestUploadKind, readonly string[]>
> = {
  openapi: [...JSON_TYPES, ...YAML_TYPES],
  postman: JSON_TYPES,
  graphql: JSON_TYPES,
  har: ['application/har+json', 'application/json'],
  config: [...JSON_TYPES, ...YAML_TYPES],
};

/** Longest filename the declaration accepts. The stored key uses a server id, so this only bounds the input. */
export const INPUT_MANIFEST_FILENAME_MAX = 255;
/** Longest content type the declaration accepts (the allowlist is far shorter; this bounds the input). */
const CONTENT_TYPE_MAX = 100;

/** Upload status of a registered object. Only `uploaded_pending_scan` exists until SCOPE-009 adds scan outcomes. */
export const INPUT_MANIFEST_UPLOAD_STATUSES = ['uploaded_pending_scan'] as const;
export const inputManifestUploadStatusSchema = z.enum(INPUT_MANIFEST_UPLOAD_STATUSES);
export type InputManifestUploadStatus = (typeof INPUT_MANIFEST_UPLOAD_STATUSES)[number];

/**
 * `POST /v1/input-manifests/:id/uploads`. The body is strict: the tenant, the object key and the storage
 * prefix are chosen by the server and never accepted here. `sizeBytes` is the declared size: the grant's
 * `Content-Length` range is bounded by it, and `complete` re-reads the real one from the store.
 */
export const createInputManifestUploadSchema = z
  .strictObject({
    kind: inputManifestUploadKindSchema,
    filename: z.string().min(1).max(INPUT_MANIFEST_FILENAME_MAX),
    contentType: z.string().min(1).max(CONTENT_TYPE_MAX),
    sizeBytes: z.number().int().min(0),
  })
  .superRefine((body, ctx) => {
    if (!INPUT_MANIFEST_CONTENT_TYPES[body.kind].includes(body.contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: 'content type is not allowed for this kind',
      });
    }
  });
export type CreateInputManifestUpload = z.infer<typeof createInputManifestUploadSchema>;

/** The presigned POST grant: send a `multipart/form-data` request to `url` with `fields`, then the file last. */
export const inputManifestUploadGrantSchema = z.strictObject({
  uploadId: z.uuid(),
  kind: inputManifestUploadKindSchema,
  objectKey: z.string().min(1),
  method: z.literal('POST'),
  url: z.url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type InputManifestUploadGrant = z.infer<typeof inputManifestUploadGrantSchema>;

/** The answer to a removed pending upload: the id of the upload and its final status. */
export const inputManifestUploadRemovedSchema = z.strictObject({
  uploadId: z.uuid(),
  status: z.literal('removed'),
});
export type InputManifestUploadRemoved = z.infer<typeof inputManifestUploadRemovedSchema>;

/** A registered object in `input_manifests.spec_objects`. Size and type are the store's, never the client's. */
export const inputManifestSpecObjectSchema = z.strictObject({
  uploadId: z.uuid(),
  kind: inputManifestUploadKindSchema,
  objectKey: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1),
  status: inputManifestUploadStatusSchema,
});
export type InputManifestSpecObject = z.infer<typeof inputManifestSpecObjectSchema>;
