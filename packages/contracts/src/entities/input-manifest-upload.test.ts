import { describe, expect, it } from 'vitest';

import {
  createInputManifestUploadSchema,
  INPUT_MANIFEST_CONTENT_TYPES,
  INPUT_MANIFEST_UPLOAD_KINDS,
  inputManifestSpecObjectSchema,
  inputManifestUploadRemovedSchema,
} from './input-manifest-upload.js';

const base = {
  kind: 'openapi',
  filename: 'api.yaml',
  contentType: 'application/yaml',
  sizeBytes: 10,
};

describe('createInputManifestUploadSchema (SCOPE-006)', () => {
  it('accepts every kind with each content type on its allowlist', () => {
    for (const kind of INPUT_MANIFEST_UPLOAD_KINDS) {
      for (const contentType of INPUT_MANIFEST_CONTENT_TYPES[kind]) {
        expect(
          createInputManifestUploadSchema.safeParse({ ...base, kind, contentType }).success,
        ).toBe(true);
      }
    }
  });

  it('refuses a content type outside the allowlist for its kind', () => {
    expect(
      createInputManifestUploadSchema.safeParse({
        ...base,
        kind: 'postman',
        contentType: 'application/yaml',
      }).success,
    ).toBe(false);
    expect(
      createInputManifestUploadSchema.safeParse({
        ...base,
        kind: 'openapi',
        contentType: 'text/html',
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown kind, an unknown key and a non-integer size', () => {
    expect(createInputManifestUploadSchema.safeParse({ ...base, kind: 'binary' }).success).toBe(
      false,
    );
    expect(
      createInputManifestUploadSchema.safeParse({ ...base, tenantId: 'another-tenant' }).success,
    ).toBe(false);
    expect(createInputManifestUploadSchema.safeParse({ ...base, sizeBytes: 1.5 }).success).toBe(
      false,
    );
    expect(createInputManifestUploadSchema.safeParse({ ...base, sizeBytes: -1 }).success).toBe(
      false,
    );
  });

  it('refuses an empty filename', () => {
    expect(createInputManifestUploadSchema.safeParse({ ...base, filename: '' }).success).toBe(
      false,
    );
  });
});

describe('inputManifestSpecObjectSchema', () => {
  const object = {
    uploadId: '0198f0a0-0000-7000-8000-000000000101',
    kind: 'har',
    objectKey: 'inputs/t/m/u-capture.har',
    sha256: 'a'.repeat(64),
    sizeBytes: 12,
    contentType: 'application/json',
    status: 'uploaded_pending_scan',
  };

  it('accepts a registered object pending scan', () => {
    expect(inputManifestSpecObjectSchema.safeParse(object).success).toBe(true);
  });

  it('refuses a digest that is not sha-256 hex, and any status but pending scan', () => {
    expect(inputManifestSpecObjectSchema.safeParse({ ...object, sha256: 'ABC' }).success).toBe(
      false,
    );
    expect(inputManifestSpecObjectSchema.safeParse({ ...object, status: 'clean' }).success).toBe(
      false,
    );
  });
});

describe('inputManifestUploadRemovedSchema', () => {
  it('accepts the id of a removed upload with status removed', () => {
    const removed = { uploadId: '0198f0a0-0000-7000-8000-000000000101', status: 'removed' };
    expect(inputManifestUploadRemovedSchema.safeParse(removed).success).toBe(true);
  });

  it('refuses any other status and any extra key (no object fields leak back)', () => {
    const uploadId = '0198f0a0-0000-7000-8000-000000000101';
    expect(
      inputManifestUploadRemovedSchema.safeParse({ uploadId, status: 'uploaded_pending_scan' })
        .success,
    ).toBe(false);
    expect(
      inputManifestUploadRemovedSchema.safeParse({ uploadId, status: 'removed', objectKey: 'x' })
        .success,
    ).toBe(false);
  });
});
