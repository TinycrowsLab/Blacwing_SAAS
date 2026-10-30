import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import {
  ADMIN_A,
  ADMIN_B,
  AUDITOR_A,
  MANIFEST_A,
  MANIFEST_B,
  memoryAudit,
  memoryManifestStore,
  memoryObjectStore,
  type MemoryObjectStore,
  NOW,
  SPEC_BYTES,
  TENANT_A,
  TENANT_B,
  tablesFor,
} from './fixtures.test-helpers.js';
import { InputManifestUploadModule, uploadSettingsOf } from './module.js';
import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';

import type { UploadManifestStore } from './service.js';
import type { Problem } from '@blackwing/contracts';
import type { TenantTx } from '@blackwing/db';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/** Test IAM: `<user>@<tenant>`, the principal the guard resolves from a header the test controls. */
const USERS: Record<string, string> = {
  'admin-a': ADMIN_A,
  'auditor-a': AUDITOR_A,
  'admin-b': ADMIN_B,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };

function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [user, tenant] = who.split('@');
  const userId = USERS[user ?? ''];
  const tenantId = TENANTS[tenant ?? ''];
  if (userId === undefined || tenantId === undefined)
    return { actor: { type: 'user', id: 'usr_none' } };
  return { actor: { type: 'user', id: userId }, sessionTenantId: tenantId };
}

const UPLOAD_ID = '0198f0a0-0000-7000-8000-000000000101';
const UNKNOWN_UPLOAD_ID = '0198f0a0-0000-7000-8000-0000000001ff';
const SPEC_KEY = `inputs/${TENANT_A}/${MANIFEST_A}/${UPLOAD_ID}-api.json`;

let app: NestFastifyApplication;
let metrics: HttpMetrics;
let objects: MemoryObjectStore;
let tables: ReturnType<typeof tablesFor>;
let auditEvents: ReturnType<typeof memoryAudit>;

beforeEach(async () => {
  metrics = createHttpMetrics();
  objects = memoryObjectStore();
  tables = tablesFor();
  auditEvents = memoryAudit();
  const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' });
  const created = await createApiApp({
    config,
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      InputManifestUploadModule.forRoot({
        // The double's transaction is its tenant; the Postgres transaction type is only a brand (see fixtures).
        store: memoryManifestStore(tables) as unknown as UploadManifestStore<TenantTx>,
        audit: auditEvents.write,
        objects,
        bucket: 'bw-inputs-test',
        settings: uploadSettingsOf(config),
        registry: metrics.registry,
        logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
        now: () => NOW,
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const as = (principal: string) => ({ 'x-test-principal': principal });
const declaration = {
  kind: 'openapi',
  filename: 'api.json',
  contentType: 'application/json',
  sizeBytes: SPEC_BYTES.byteLength,
};

function grant(principal: string, manifestId: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: `/v1/input-manifests/${manifestId}/uploads`,
    headers: { ...as(principal), 'content-type': 'application/json' },
    payload: body as Record<string, unknown>,
  });
}

function complete(principal: string, manifestId: string, uploadId: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/input-manifests/${manifestId}/uploads/${uploadId}/complete`,
    headers: as(principal),
  });
}

function remove(principal: string, manifestId: string, uploadId: string) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/input-manifests/${manifestId}/uploads/${uploadId}`,
    headers: as(principal),
  });
}

describe('POST /v1/input-manifests/:id/uploads (SCOPE-006)', () => {
  it('grants a presigned POST with no-store caching and the server key', async () => {
    const res = await grant('admin-a@a', MANIFEST_A, declaration);
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ objectKey: string }>();
    expect(body).toMatchObject({
      kind: 'openapi',
      method: 'POST',
      url: 'https://store.test/bw-inputs-test',
      expiresAt: '2026-10-30T10:05:00.000Z',
    });
    expect(body.objectKey).toMatch(
      new RegExp(`^inputs/${TENANT_A}/${MANIFEST_A}/[0-9a-f-]{36}-api\\.json$`),
    );
  });

  it('refuses a request without any principal with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/input-manifests/${MANIFEST_A}/uploads`,
      headers: { 'content-type': 'application/json' },
      payload: declaration,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a content type outside the kind allowlist with 422', async () => {
    const res = await grant('admin-a@a', MANIFEST_A, {
      ...declaration,
      kind: 'postman',
      contentType: 'application/yaml',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('validation_failed');
  });

  it('refuses an unknown body key (a client-chosen tenant or key) with 422', async () => {
    const res = await grant('admin-a@a', MANIFEST_A, { ...declaration, tenantId: TENANT_B });
    expect(res.statusCode).toBe(422);
  });

  it('refuses an empty declaration with 422 scope_empty_upload', async () => {
    const res = await grant('admin-a@a', MANIFEST_A, { ...declaration, sizeBytes: 0 });
    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('scope_empty_upload');
  });

  it('refuses a declaration over the configured limit with 413 scope_upload_too_large', async () => {
    const res = await grant('admin-a@a', MANIFEST_A, { ...declaration, sizeBytes: 26_214_401 });
    expect(res.statusCode).toBe(413);
    expect(res.json<Problem>().code).toBe('scope_upload_too_large');
  });

  it('refuses a member without assessment:create with 403', async () => {
    const res = await grant('auditor-a@a', MANIFEST_A, declaration);
    expect(res.statusCode).toBe(403);
  });

  it('answers 404 for another tenant manifest and for a malformed manifest id', async () => {
    expect((await grant('admin-a@a', MANIFEST_B, declaration)).statusCode).toBe(404);
    expect((await grant('admin-a@a', 'not-a-uuid', declaration)).statusCode).toBe(404);
  });
});

describe('POST /v1/input-manifests/:id/uploads/:uploadId/complete (SCOPE-006)', () => {
  it('registers the uploaded object as pending scan and answers it again on a replay', async () => {
    await grant('admin-a@a', MANIFEST_A, declaration);
    objects.put(SPEC_KEY, {
      bytes: SPEC_BYTES,
      contentType: 'application/json',
      metadata: { kind: 'openapi' },
    });
    const first = await complete('admin-a@a', MANIFEST_A, UPLOAD_ID);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      uploadId: UPLOAD_ID,
      status: 'uploaded_pending_scan',
      objectKey: SPEC_KEY,
    });
    const replay = await complete('admin-a@a', MANIFEST_A, UPLOAD_ID);
    expect(replay.json()).toEqual(first.json());
  });

  it('answers 409 scope_object_missing when no object was uploaded', async () => {
    await grant('admin-a@a', MANIFEST_A, declaration);
    const res = await complete('admin-a@a', MANIFEST_A, UPLOAD_ID);
    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('scope_object_missing');
  });

  it('answers 404 for another tenant and for a malformed upload id', async () => {
    expect((await complete('admin-a@a', MANIFEST_B, UPLOAD_ID)).statusCode).toBe(404);
    expect((await complete('admin-a@a', MANIFEST_A, 'nope')).statusCode).toBe(404);
  });
});

describe('DELETE /v1/input-manifests/:id/uploads/:uploadId (SCOPE-006)', () => {
  it('removes a pending upload with 200 and its id, then answers 404 for it', async () => {
    await grant('admin-a@a', MANIFEST_A, declaration);
    objects.put(SPEC_KEY, {
      bytes: SPEC_BYTES,
      contentType: 'application/json',
      metadata: { kind: 'openapi' },
    });
    await complete('admin-a@a', MANIFEST_A, UPLOAD_ID);
    const res = await remove('admin-a@a', MANIFEST_A, UPLOAD_ID);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ uploadId: string; status: string }>()).toEqual({
      uploadId: UPLOAD_ID,
      status: 'removed',
    });
    expect(objects.deleted).toEqual([SPEC_KEY]);
    expect((await remove('admin-a@a', MANIFEST_A, UPLOAD_ID)).statusCode).toBe(404);
  });

  it('answers 404 for an unknown upload and never touches another tenant', async () => {
    expect((await remove('admin-a@a', MANIFEST_A, UNKNOWN_UPLOAD_ID)).statusCode).toBe(404);
    expect((await remove('admin-a@a', MANIFEST_B, UPLOAD_ID)).statusCode).toBe(404);
    expect(objects.deleted).toEqual([]);
  });
});

describe('upload audit trail (§8.8)', () => {
  it('records requested, completed and deleted events in order', async () => {
    await grant('admin-a@a', MANIFEST_A, declaration);
    objects.put(SPEC_KEY, {
      bytes: SPEC_BYTES,
      contentType: 'application/json',
      metadata: { kind: 'openapi' },
    });
    await complete('admin-a@a', MANIFEST_A, UPLOAD_ID);
    await remove('admin-a@a', MANIFEST_A, UPLOAD_ID);
    expect(auditEvents.events.map((event) => event.action)).toEqual([
      'scope.manifest.upload_requested',
      'scope.manifest.upload_completed',
      'scope.manifest.upload_deleted',
    ]);
  });
});
